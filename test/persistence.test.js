'use strict';

/**
 * Проверка, что демо-сервер переживает перезапуск (важно для облака: деплой,
 * рестарт контейнера, падение процесса) и выдаёт TURN-учётные данные.
 *
 * Запуск: node test/persistence.test.js
 */

const { after, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 3197;
const BASE = `http://127.0.0.1:${PORT}`;
const STATE_FILE = process.env.TEST_STATE_FILE
  || path.join(os.tmpdir(), `legion-persistence-test-${process.pid}.json`);
const TURN_SECRET = 'test-turn-secret';
const sha256 = (value) => crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');

let child = null;

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${BASE}/health/live`);
      if (response.ok) return;
    } catch (error) {
      // сервер ещё поднимается
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('demo server did not start');
}

function startServer() {
  child = spawn(process.execPath, [path.join(__dirname, '..', 'server-dev.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      ADMIN_PASSWORD: 'demo-admin-pass',
      STATE_FILE,
      TURN_URLS: 'turn:turn.example.com:3478?transport=udp',
      TURN_SHARED_SECRET: TURN_SECRET,
    },
    stdio: 'ignore',
  });
}

async function stopServer() {
  if (!child) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
  child = null;
}

async function api(pathname, { method = 'GET', token, deviceId, body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (deviceId) headers['x-device-id'] = deviceId;
  const response = await fetch(`${BASE}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

describe('state persistence and TURN credentials', () => {
  after(async () => {
    await stopServer();
    try { fs.unlinkSync(STATE_FILE); } catch (error) { /* уже удалён */ }
  });

  it('survives a restart with users, tokens, devices and messages', async () => {
    try { fs.unlinkSync(STATE_FILE); } catch (error) { /* файла ещё нет */ }
    startServer();
    await waitForServer();

    const adminToken = (await api('/api/auth/dev', {
      method: 'POST',
      body: { username: 'admin', passwordHash: sha256('demo-admin-pass') },
    })).body.token;

    await api('/api/registration-codes', {
      method: 'POST',
      token: adminToken,
      body: { username: 'persist', code: 'PERSIST-1' },
    });

    const userToken = (await api('/api/auth/dev', {
      method: 'POST',
      body: { username: 'persist', passwordHash: sha256('PersistPass1') },
    })).body.token;

    await api('/api/registration-codes/verify', {
      method: 'POST',
      token: userToken,
      body: { username: 'persist', code: 'PERSIST-1' },
    });
    await api('/api/register', {
      method: 'POST',
      token: userToken,
      body: { phoneId: 'device-persist', name: 'Тест' },
    });

    await api('/api/registration-codes', {
      method: 'POST',
      token: adminToken,
      body: { username: 'persist-peer', code: 'PERSIST-PEER-1' },
    });
    const peerToken = (await api('/api/auth/dev', {
      method: 'POST',
      body: { username: 'persist-peer', passwordHash: sha256('PersistPeer1') },
    })).body.token;
    await api('/api/registration-codes/verify', {
      method: 'POST',
      token: peerToken,
      body: { username: 'persist-peer', code: 'PERSIST-PEER-1' },
    });
    await api('/api/register', {
      method: 'POST',
      token: peerToken,
      body: { phoneId: 'device-persist-peer', name: 'Получатель' },
    });

    await api('/api/send', {
      method: 'POST',
      token: userToken,
      deviceId: 'device-persist',
      body: {
        to: 'all',
        text: 'сообщение до перезапуска',
        data: { type: 'text', chat_id: 'general' },
      },
    });

    const ice = await api('/api/rtc/ice-servers', { token: userToken, deviceId: 'device-persist' });
    assert.equal(ice.status, 200);
    const turn = ice.body.iceServers.find((server) => String(server.urls).includes('turn:'));
    assert.ok(turn, 'TURN server is advertised');
    assert.match(turn.username, /^\d+:persist$/);
    const expectedCredential = crypto.createHmac('sha1', TURN_SECRET).update(turn.username).digest('base64');
    assert.equal(turn.credential, expectedCredential);

    await new Promise((resolve) => setTimeout(resolve, 800)); // ждём debounce-сохранение
    await stopServer();

    startServer();
    await waitForServer();

    const phones = await api('/api/phones', { token: userToken, deviceId: 'device-persist' });
    assert.equal(phones.status, 200, 'токен пережил перезапуск');

    const messages = await api('/api/messages', { token: peerToken, deviceId: 'device-persist-peer' });
    assert.equal(messages.status, 200);
    assert.equal(messages.body.length, 1);
    assert.equal(messages.body[0].text, 'сообщение до перезапуска');
  });
});
