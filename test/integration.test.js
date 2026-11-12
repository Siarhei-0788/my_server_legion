'use strict';

/**
 * Интеграционные тесты production-сервера: реальные PostgreSQL и Redis.
 *
 * Запуск:
 *   $env:TEST_DATABASE_URL='postgres://legion:legion@127.0.0.1:5432/legion_test'
 *   $env:TEST_REDIS_URL='redis://127.0.0.1:6379'
 *   node test/integration.test.js
 *
 * Без этих переменных тесты пропускаются — так они не мешают локальной работе
 * без Docker. В CI (.github/workflows/server-ci.yml) сервисы поднимаются.
 */

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const TEST_REDIS_URL = process.env.TEST_REDIS_URL;
const hasInfra = Boolean(TEST_DATABASE_URL && TEST_REDIS_URL);
const TEST_PORT = Number(process.env.TEST_PORT || 3200);
const BASE = `http://127.0.0.1:${TEST_PORT}`;

if (hasInfra) {
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.REDIS_URL = TEST_REDIS_URL;
  process.env.PORT = String(TEST_PORT);
  process.env.FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'legion-integration-test';
  process.env.REGISTRATION_CODE_SECRET =
    process.env.REGISTRATION_CODE_SECRET || 'integration-secret-0123456789-0123456789';
}

const { after, before, describe, it } = require('node:test');
const assert = require('node:assert/strict');

const serverModule = hasInfra ? require('../server.js') : null;
const migrateModule = hasInfra ? require('../migrate.js') : null;

describe('production server (PostgreSQL + Redis)', { skip: !hasInfra && 'TEST_DATABASE_URL/TEST_REDIS_URL are not set' }, () => {
  before(async () => {
    await migrateModule.migrate();
    await serverModule.start();
  });

  after(async () => {
    await serverModule.stop();
  });

  it('reports liveness', async () => {
    const response = await fetch(`${BASE}/health/live`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok' });
  });

  it('reports readiness only when PostgreSQL and Redis are reachable', async () => {
    const response = await fetch(`${BASE}/health/ready`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ready' });
  });

  it('returns 401 for protected endpoints without a Firebase token', async () => {
    const messages = await fetch(`${BASE}/api/messages`, { headers: { 'x-device-id': 'device-x' } });
    assert.equal(messages.status, 401);

    const users = await fetch(`${BASE}/api/users`);
    assert.equal(users.status, 401);

    const chats = await fetch(`${BASE}/api/chats/test-chat`, { method: 'DELETE' });
    assert.equal(chats.status, 401);

    const send = await fetch(`${BASE}/api/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: 'all', text: 'hello', data: { type: 'text' } }),
    });
    assert.equal(send.status, 401);
  });

  it('adds a request id to every response and echoes a valid incoming one', async () => {
    const generated = await fetch(`${BASE}/health/live`);
    assert.match(generated.headers.get('x-request-id') || '', /^[0-9a-f-]{36}$/i);

    const echoed = await fetch(`${BASE}/health/live`, { headers: { 'x-request-id': 'abc-123' } });
    assert.equal(echoed.headers.get('x-request-id'), 'abc-123');
  });

  it('applies the schema migration with retention index', async () => {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: TEST_DATABASE_URL });
    try {
      const index = await pool.query("SELECT indexname FROM pg_indexes WHERE tablename = 'messages' AND indexname = 'messages_created_at_idx'");
      assert.equal(index.rowCount, 1);
      const tables = await pool.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename");
      assert.deepEqual(
        tables.rows.map((row) => row.tablename),
        ['call_participants', 'calls', 'chat_members', 'chats', 'deleted_users', 'devices', 'messages', 'registration_codes']
      );
    } finally {
      await pool.end();
    }
  });
});
