'use strict';

/**
 * Проверка сигналинга звонка на демо-сервере: вызов → принятие → SDP → ICE → завершение.
 * Запуск: node test/rtc-signaling.test.js
 */

const { after, before, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { io } = require('socket.io-client');

const PORT = 3198;
const BASE = `http://127.0.0.1:${PORT}`;
const STATE_FILE = path.join(os.tmpdir(), `legion-rtc-test-${process.pid}.json`);
const sha256 = (value) => crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');

let child;
const sockets = [];

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

async function devLogin(username, password) {
  const response = await api('/api/auth/dev', {
    method: 'POST',
    body: { username, passwordHash: sha256(password) },
  });
  assert.equal(response.status, 200);
  return response.body.token;
}

async function prepareUser(adminToken, username, phoneId) {
  const code = `${username.toUpperCase()}-CODE`;
  await api('/api/registration-codes', {
    method: 'POST',
    token: adminToken,
    body: { username, code },
  });
  const token = await devLogin(username, `${username}Pass1`);
  await api('/api/registration-codes/verify', {
    method: 'POST',
    token,
    body: { username, code },
  });
  await api('/api/register', {
    method: 'POST',
    token,
    body: { phoneId, name: username },
  });
  return token;
}

function connect(token, phoneId) {
  const socket = io(BASE, {
    auth: { idToken: token, phoneId },
    transports: ['websocket'],
    reconnection: false,
  });
  sockets.push(socket);
  return socket;
}

function once(socket, event, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs);
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

function emit(socket, event, payload, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout ack for ${event}`)), timeoutMs);
    socket.emit(event, payload, (response) => {
      clearTimeout(timer);
      resolve(response);
    });
  });
}

before(async () => {
  try { fs.unlinkSync(STATE_FILE); } catch (error) { /* файла ещё нет */ }
  child = spawn(process.execPath, [path.join(__dirname, '..', 'server-dev.js')], {
    env: { ...process.env, PORT: String(PORT), ADMIN_PASSWORD: 'demo-admin-pass', STATE_FILE: 'off' },
    stdio: 'ignore',
  });
  await waitForServer();
});

after(() => {
  for (const socket of sockets) socket.disconnect();
  if (child) child.kill();
  try { fs.unlinkSync(STATE_FILE); } catch (error) { /* уже удалён */ }
});

describe('rtc signaling', () => {
  it('connects both peers, negotiates SDP/ICE and ends the call', async () => {
    const adminToken = await devLogin('admin', 'demo-admin-pass');
    const aliceToken = await prepareUser(adminToken, 'alice', 'phone-alice');
    const bobToken = await prepareUser(adminToken, 'bob', 'phone-bob');

    const alice = connect(aliceToken, 'phone-alice');
    const bob = connect(bobToken, 'phone-bob');
    await Promise.all([once(alice, 'connect'), once(bob, 'connect')]);

    const incoming = once(bob, 'rtc:incoming');
    const callAck = await emit(alice, 'rtc:call', { to: 'phone-bob', callType: 'audio' });
    assert.equal(callAck.ok, true, JSON.stringify(callAck));
    const call = await incoming;
    assert.equal(call.callId, callAck.callId);
    assert.equal(call.callType, 'audio');

    const accepted = once(alice, 'rtc:accepted');
    assert.equal((await emit(bob, 'rtc:accept', { callId: call.callId })).ok, true);
    await accepted;

    const offerReceived = once(bob, 'rtc:offer');
    assert.equal((await emit(alice, 'rtc:offer', {
      callId: call.callId,
      description: { type: 'offer', sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n' },
    })).ok, true);
    const offer = await offerReceived;
    assert.equal(offer.description.type, 'offer');

    const answerReceived = once(alice, 'rtc:answer');
    assert.equal((await emit(bob, 'rtc:answer', {
      callId: call.callId,
      description: { type: 'answer', sdp: 'v=0\r\no=- 2 2 IN IP4 127.0.0.1\r\n' },
    })).ok, true);
    await answerReceived;

    const iceReceived = once(alice, 'rtc:ice-candidate');
    assert.equal((await emit(bob, 'rtc:ice-candidate', {
      callId: call.callId,
      candidate: { candidate: 'candidate:1 1 udp 2122260223 192.168.1.2 5000 typ host', sdpMid: '0', sdpMLineIndex: 0 },
    })).ok, true);
    await iceReceived;

    const ended = once(bob, 'rtc:ended');
    assert.equal((await emit(alice, 'rtc:hangup', { callId: call.callId })).ok, true);
    const end = await ended;
    assert.equal(end.reason, 'hangup');
  });

  it('rejects a second call while the peer is busy', async () => {
    const adminToken = await devLogin('admin', 'demo-admin-pass');
    const carolToken = await prepareUser(adminToken, 'carol', 'phone-carol');
    const daveToken = await prepareUser(adminToken, 'dave', 'phone-dave');

    const carol = connect(carolToken, 'phone-carol');
    const dave = connect(daveToken, 'phone-dave');
    await Promise.all([once(carol, 'connect'), once(dave, 'connect')]);

    const first = await emit(carol, 'rtc:call', { to: 'phone-dave', callType: 'audio' });
    assert.equal(first.ok, true);

    const second = await emit(dave, 'rtc:call', { to: 'phone-carol', callType: 'video' });
    assert.equal(second.ok, false);
    assert.equal(second.error, 'user_busy');
  });

  it('shares tactical marks with everyone and notifies over the socket', async () => {
    const adminToken = await devLogin('admin', 'demo-admin-pass');
    const gregToken = await prepareUser(adminToken, 'greg', 'phone-greg');
    const hankToken = await prepareUser(adminToken, 'hank', 'phone-hank');
    const hank = connect(hankToken, 'phone-hank');
    await once(hank, 'connect');

    const markId = '6f1d2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b';
    const changed = once(hank, 'marks:changed');
    const created = await api('/api/marks', {
      method: 'POST', token: gregToken,
      body: { id: markId, type: 'Огневая точка', label: 'ОТ-1', lat: 55.75, lng: 37.61, icon: 'builtin:fire' },
    });
    assert.equal(created.status, 200);
    await changed; // знак появляется у других в реальном времени
    const listed = await api('/api/marks', { token: hankToken });
    assert.equal(listed.body.find((mark) => mark.id === markId).createdBy, 'greg');

    // Повторная отправка того же id не создаёт дубликат.
    await api('/api/marks', { method: 'POST', token: gregToken, body: { id: markId, type: 'X', lat: 1, lng: 1 } });
    assert.equal((await api('/api/marks', { token: hankToken })).body.filter((mark) => mark.id === markId).length, 1);

    const batch = await api('/api/marks/batch', {
      method: 'POST', token: hankToken,
      body: { marks: [
        { id: '11111111-2222-4333-8444-555555555555', type: 'Точка', label: 'WP1', lat: 55.1, lng: 37.1 },
        { id: '11111111-2222-4333-8444-666666666666', type: 'Точка', label: 'WP2', lat: 55.2, lng: 37.2 },
      ] },
    });
    assert.equal(batch.body.added, 2);
    assert.equal((await api('/api/marks/batch', { method: 'POST', token: hankToken, body: { marks: [{ id: 'bad' }] } })).status, 400);

    // Удалить может автор или администратор.
    assert.equal((await api(`/api/marks/${markId}`, { method: 'DELETE', token: hankToken })).status, 403);
    assert.equal((await api(`/api/marks/${markId}`, { method: 'DELETE', token: adminToken })).status, 200);

    // Значок: только PNG до 100 КБ.
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');
    assert.equal((await api('/api/marks/icons', { method: 'POST', token: gregToken, body: { id: 'tank', name: 'Танк', data: png } })).status, 200);
    assert.equal((await api('/api/marks/icons', { method: 'POST', token: gregToken, body: { id: 'bad', name: 'x', data: 'aGVsbG8=' } })).status, 400);
    assert.equal((await api('/api/marks/icons/tank', { token: hankToken })).body.data, png);
    assert.equal((await api('/api/marks/icons', { method: 'POST', token: hankToken, body: { id: 'tank', name: 'Чужой', data: png } })).status, 409);
  });

  it('ends an accepted call when the call screen disconnects without hangup', async () => {
    const adminToken = await devLogin('admin', 'demo-admin-pass');
    const eveToken = await prepareUser(adminToken, 'eve', 'phone-eve');
    const frankToken = await prepareUser(adminToken, 'frank', 'phone-frank');

    const eve = connect(eveToken, 'phone-eve');
    const frankBackground = connect(frankToken, 'phone-frank'); // фоновый сокет (AlertService)
    await Promise.all([once(eve, 'connect'), once(frankBackground, 'connect')]);

    const incoming = once(frankBackground, 'rtc:incoming');
    const call = await emit(eve, 'rtc:call', { to: 'phone-frank', callType: 'audio' });
    assert.equal(call.ok, true);
    await incoming;

    const frankCall = connect(frankToken, 'phone-frank'); // экран звонка
    await once(frankCall, 'connect');
    assert.equal((await emit(frankCall, 'rtc:accept', { callId: call.callId })).ok, true);

    const ended = once(eve, 'rtc:ended');
    frankCall.disconnect(); // закрыли экран без «Завершить»
    assert.equal((await ended).reason, 'disconnected');

    // Звонок не завис: можно звонить снова.
    const again = await emit(eve, 'rtc:call', { to: 'phone-frank', callType: 'audio' });
    assert.equal(again.ok, true, JSON.stringify(again));
  });
});
