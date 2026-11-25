'use strict';

/**
 * Push-уведомления: проверка того, что админ может отправить оповещение подразделению,
 * а устройство получает его событиями сокета (в демо-режиме, когда FCM не настроен).
 *
 * Клиент слушает два канала:
 *  1) `push:message` — общий demo-push (POST /api/push);
 *  2) `chats:changed` — изменение чатов (не здесь, в chat-admin.test.js).
 *
 * Запуск: node test/push-notifications.test.js
 */

const { after, before, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const path = require('node:path');
const { io } = require('socket.io-client');

const PORT = 3195;
const BASE = `http://127.0.0.1:${PORT}`;
const sha256 = (value) => crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
let child;

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${BASE}/health/live`);
      if (response.ok) return;
    } catch (error) { /* сервер ещё поднимается */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('demo server did not start');
}

async function api(pathname, { method = 'GET', token, body, deviceId } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (deviceId) headers['x-device-id'] = deviceId;
  const response = await fetch(`${BASE}${pathname}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function devLogin(username, password) {
  const response = await api('/api/auth/dev', { method: 'POST', body: { username, passwordHash: sha256(password) } });
  assert.equal(response.status, 200, `login failed for ${username}`);
  return response.body.token;
}

async function readyUser(username, code, password, phoneId) {
  const adminToken = await devLogin('admin', 'demo-admin-pass');
  const token = await devLogin(username, password);
  await api('/api/registration-codes', { method: 'POST', token: adminToken, body: { username, code } });
  await api('/api/registration-codes/verify', { method: 'POST', token, body: { username, code } });
  await api('/api/register', { method: 'POST', token, body: { phoneId, name: 'Pixel', callsign: username } });
  return { token, adminToken };
}

function openSocket(token, phoneId) {
  const socket = io(BASE, { transports: ['websocket'], forceNew: true, auth: { idToken: token, phoneId } });
  return new Promise((resolve, reject) => {
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', reject);
    setTimeout(() => reject(new Error('socket did not connect')), 5000);
  });
}

before(async () => {
  child = spawn(process.execPath, [path.join(__dirname, '..', 'server-dev.js')], {
    env: { ...process.env, PORT: String(PORT), ADMIN_PASSWORD: 'demo-admin-pass', STATE_FILE: 'off' },
    stdio: 'ignore',
  });
  await waitForServer();
});

after(() => {
  if (child) child.kill();
});

describe('push notifications (demo delivery over socket)', () => {
  it('delivers an admin push to a connected device', async () => {
    const alice = await readyUser('alice', 'ALICE-PUSH', 'AlicePass1', 'device-alice-push');
    const socket = await openSocket(alice.token, 'device-alice-push');
    try {
      const received = new Promise((resolve) => {
        socket.on('push:message', (payload) => resolve(payload));
        setTimeout(() => resolve(null), 3000);
      });
      const sent = await api('/api/push', {
        method: 'POST', token: alice.adminToken,
        body: { title: 'Построение', body: 'Всем прибыть к КПП', data: { type: 'admin_push' } },
      });
      assert.equal(sent.status, 200);
      assert.equal(sent.body.demo, true);
      const payload = await received;
      assert.ok(payload, 'устройство получило push:message');
      assert.equal(payload.title, 'Построение');
      assert.equal(payload.body, 'Всем прибыть к КПП');
      assert.equal(payload.data.type, 'admin_push');
    } finally {
      socket.close();
    }
  });

  it('forbids a non-admin to push and rejects empty payloads', async () => {
    const alice = await readyUser('alice', 'ALICE-PUSH', 'AlicePass1', 'device-alice-push');
    assert.equal((await api('/api/push', {
      method: 'POST', token: alice.token, body: { title: 'Я', body: 'не командир' },
    })).status, 403);

    assert.equal((await api('/api/push', {
      method: 'POST', token: alice.adminToken, body: { title: '', body: '' },
    })).status, 400);
  });

  it('accepts an FCM token from a registered device', async () => {
    const alice = await readyUser('alice', 'ALICE-PUSH', 'AlicePass1', 'device-alice-push');
    // В dev-режиме FCM не используется, но клиент сообщает токен — сервер его принимает,
    // чтобы переключение на production не требовало передеплоя приложения.
    const registered = await api('/api/push/token', {
      method: 'POST', token: alice.token, deviceId: 'device-alice-push',
      body: { fcmToken: 'fcm-token-0123456789' },
    });
    assert.equal(registered.status, 200);
    assert.equal(registered.body.demo, true);

    // Без зарегистрированного устройства — отказ.
    const stranger = await devLogin('carol', 'CarolPass1');
    assert.equal((await api('/api/push/token', {
      method: 'POST', token: stranger, body: { fcmToken: 'fcm-token-0123456789' },
    })).status, 403);
  });
});
