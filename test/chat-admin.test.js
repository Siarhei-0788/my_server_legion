'use strict';

/**
 * Контракт управления чатами:
 *  — администратор удаляет ЛЮБОЙ чат, включая чужой (раньше клиент из постороннего чата
 *    вообще не показывал удаление; сервер на это уже соглашался — теперь есть тест);
 *  — создатель или администратор меняет состав участников (PUT /api/chats/:id/members),
 *    создателя убрать нельзя, удалённого пользователя добавить нельзя;
 *  — удалённый чат пропадает у всех: GET /api/chats больше его не возвращает, а участники
 *    получают событие chats:changed.
 *
 * Запуск: node test/chat-admin.test.js
 */

const { after, before, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const path = require('node:path');
const { io } = require('socket.io-client');

const PORT = 3196;
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

async function grantAccess(adminToken, username, code, token) {
  await api('/api/registration-codes', { method: 'POST', token: adminToken, body: { username, code } });
  assert.equal((await api('/api/registration-codes/verify', { method: 'POST', token, body: { username, code } })).status, 200);
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

describe('chat administration', () => {
  it('lets the administrator delete any chat and broadcasts the change', async () => {
    const adminToken = await devLogin('admin', 'demo-admin-pass');
    const aliceToken = await devLogin('alice', 'AlicePass1');
    await grantAccess(adminToken, 'alice', 'ALICE-CHAT', aliceToken);
    await api('/api/register', { method: 'POST', token: aliceToken, body: { phoneId: 'device-alice', name: 'Pixel', callsign: 'Альфа' } });
    const bobToken = await devLogin('bob', 'BobPass12');
    await grantAccess(adminToken, 'bob', 'BOB-CHAT', bobToken);
    await api('/api/register', { method: 'POST', token: bobToken, body: { phoneId: 'device-bob', name: 'Pixel', callsign: 'Браво' } });

    const chatId = '7c0f2a0e-aaaa-4bbb-8ccc-000000000001';
    assert.equal((await api('/api/chats', {
      method: 'POST', token: aliceToken, body: { id: chatId, name: 'Разведка', members: ['alice', 'bob'] },
    })).status, 200);

    // bob — не создатель: удалить не может.
    assert.equal((await api(`/api/chats/${chatId}`, { method: 'DELETE', token: bobToken })).status, 404);

    // Подключаемся сокетом боба и ждём chats:changed при удалении администратором.
    const socket = io(BASE, {
      transports: ['websocket'], forceNew: true,
      auth: { idToken: bobToken, phoneId: 'device-bob' },
    });
    const changed = new Promise((resolve) => {
      socket.on('chats:changed', (payload) => resolve(payload));
      setTimeout(() => resolve(null), 3000);
    });
    await new Promise((resolve) => socket.on('connect', resolve));

    const deleted = await api(`/api/chats/${chatId}`, { method: 'DELETE', token: adminToken });
    assert.equal(deleted.status, 200, 'администратор удаляет чужой чат');

    const event = await changed;
    socket.close();
    assert.ok(event, 'участники получили chats:changed');
    assert.equal(event.chatId, chatId);
    assert.equal(event.deleted, true);

    assert.ok(!(await api('/api/chats', { token: aliceToken })).body.some((chat) => chat.id === chatId));
    assert.ok(!(await api('/api/chats', { token: bobToken })).body.some((chat) => chat.id === chatId));
  });

  it('lets the creator or administrator edit the member list', async () => {
    const adminToken = await devLogin('admin', 'demo-admin-pass');
    const aliceToken = await devLogin('alice', 'AlicePass1');
    const bobToken = await devLogin('bob', 'BobPass12');
    const carolToken = await devLogin('carol', 'CarolPass1');
    await grantAccess(adminToken, 'carol', 'CAROL-CHAT', carolToken);
    await api('/api/register', { method: 'POST', token: carolToken, body: { phoneId: 'device-carol', name: 'Pixel', callsign: 'Чарли' } });

    const chatId = '7c0f2a0e-aaaa-4bbb-8ccc-000000000002';
    assert.equal((await api('/api/chats', {
      method: 'POST', token: aliceToken, body: { id: chatId, name: 'Штурмовой отряд', members: ['alice', 'bob'] },
    })).status, 200);

    // Посторонний изменить состав не может.
    assert.equal((await api(`/api/chats/${chatId}/members`, {
      method: 'PUT', token: carolToken, body: { members: ['alice', 'bob', 'carol'] },
    })).status, 403);

    // Создателя нельзя убрать из чата.
    assert.equal((await api(`/api/chats/${chatId}/members`, {
      method: 'PUT', token: aliceToken, body: { members: ['bob'] },
    })).status, 400);

    // Создатель добавляет carol и убирает bob.
    const updated = await api(`/api/chats/${chatId}/members`, {
      method: 'PUT', token: aliceToken, body: { members: ['alice', 'carol'] },
    });
    assert.equal(updated.status, 200);
    assert.deepEqual(updated.body.added, ['carol']);
    assert.deepEqual(updated.body.removed, ['bob']);

    const carolChats = (await api('/api/chats', { token: carolToken })).body;
    assert.ok(carolChats.some((chat) => chat.id === chatId), 'добавленный участник видит чат');
    const bobChats = (await api('/api/chats', { token: bobToken })).body;
    assert.ok(!bobChats.some((chat) => chat.id === chatId), 'убранный участник чат больше не видит');

    // Сообщение от бывшего участника не попадает в чат.
    const send = await api('/api/send', {
      method: 'POST', token: bobToken, deviceId: 'device-bob',
      body: { to: 'all', text: 'Я ещё тут?', data: { type: 'text', chat_id: chatId } },
    });
    assert.equal(send.status, 403);

    // Администратор тоже может менять состав (даже чужого чата).
    assert.equal((await api(`/api/chats/${chatId}/members`, {
      method: 'PUT', token: adminToken, body: { members: ['alice', 'bob', 'carol'] },
    })).status, 200);
  });
});
