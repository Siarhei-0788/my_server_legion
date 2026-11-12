'use strict';

/**
 * Юнит-тесты чистых функций production-сервера.
 * Не требуют PostgreSQL, Redis и Firebase.
 */

process.env.REGISTRATION_CODE_SECRET = process.env.REGISTRATION_CODE_SECRET || 'test-secret-0123456789-0123456789-abc';
process.env.FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'legion-test';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://legion:legion@127.0.0.1:1/legion_test';
process.env.REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:1';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { containsSensitiveField, getBearerToken, registrationCodeDigest, toFcmData, app } = require('../server.js');

describe('server helpers', () => {
  it('extracts only well-formed bearer tokens', () => {
    assert.equal(getBearerToken('Bearer abc123'), 'abc123');
    assert.equal(getBearerToken('bearer abc123'), undefined);
    assert.equal(getBearerToken('Bearer'), undefined);
    assert.equal(getBearerToken('Basic abc'), undefined);
    assert.equal(getBearerToken(undefined), undefined);
  });

  it('detects sensitive fields recursively', () => {
    assert.equal(containsSensitiveField({ password: 'x' }), true);
    assert.equal(containsSensitiveField({ nested: { refresh_token: 'x' } }), true);
    assert.equal(containsSensitiveField([{ deep: [{ registration_code: 'x' }] }]), true);
    assert.equal(containsSensitiveField({ text: 'hello', data: { type: 'text' } }), false);
    assert.equal(containsSensitiveField(null), false);
  });

  it('converts FCM data values to strings and drops empty ones', () => {
    assert.deepEqual(toFcmData({ a: 1, b: null, c: undefined, d: 'x' }), { a: '1', d: 'x' });
    assert.deepEqual(toFcmData(null), {});
  });

  it('derives a stable registration code digest', () => {
    const digest = registrationCodeDigest('Alice', ' ab-12cd ');
    assert.match(digest, /^[a-f0-9]{64}$/);
    assert.equal(digest, registrationCodeDigest(' alice ', 'AB-12CD'));

    const expected = crypto.createHmac('sha256', process.env.REGISTRATION_CODE_SECRET)
      .update('alice:AB-12CD')
      .digest('hex');
    assert.equal(digest, expected);
  });

  it('serves liveness and adds a request id without any infrastructure', async () => {
    const listener = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => listener.once('listening', resolve));
    const { port } = listener.address();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health/live`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { status: 'ok' });
      assert.match(response.headers.get('x-request-id') || '', /^[0-9a-f-]{36}$/i);

      const echoed = await fetch(`http://127.0.0.1:${port}/health/live`, {
        headers: { 'x-request-id': 'smoke-1' },
      });
      assert.equal(echoed.headers.get('x-request-id'), 'smoke-1');
    } finally {
      await new Promise((resolve) => listener.close(resolve));
    }
  });
});
