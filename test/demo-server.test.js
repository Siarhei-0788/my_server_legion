'use strict';

/**
 * Контрактные тесты демонстрационного сервера.
 * Запуск: node --test test/
 */

const { after, before, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 3199;
const BASE = `http://127.0.0.1:${PORT}`;
const STATE_FILE = path.join(os.tmpdir(), `legion-demo-test-${process.pid}.json`);
const sha256 = (value) => crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');

let child;

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
  assert.equal(response.status, 200, `dev login failed for ${username}`);
  return response.body.token;
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
  if (child) child.kill();
  try { fs.unlinkSync(STATE_FILE); } catch (error) { /* уже удалён */ }
});

describe('demo server contract', () => {
  it('requires a token for protected endpoints', async () => {
    const response = await api('/api/messages');
    assert.equal(response.status, 401);
  });

  it('runs the registration code flow and exchanges messages', async () => {
    const adminToken = await devLogin('admin', 'demo-admin-pass');

    assert.equal((await api('/api/registration-codes', {
      method: 'POST',
      token: adminToken,
      body: { username: 'alice', code: 'ALICE-CODE-1' },
    })).status, 200);

    const aliceToken = await devLogin('alice', 'AlicePass1');
    assert.equal((await api('/api/messages', { token: aliceToken })).status, 403, 'alice has no access yet');
    assert.equal((await api('/api/registration-codes/verify', {
      method: 'POST',
      token: aliceToken,
      body: { username: 'alice', code: 'ALICE-CODE-1' },
    })).status, 200);

    assert.equal((await api('/api/register', {
      method: 'POST',
      token: aliceToken,
      body: { phoneId: 'device-alice', name: 'Алиса' },
    })).status, 200);

    assert.equal((await api('/api/registration-codes', {
      method: 'POST',
      token: adminToken,
      body: { username: 'bob', code: 'BOB-CODE-01' },
    })).status, 200);
    const bobToken = await devLogin('bob', 'BobPass12');
    await api('/api/registration-codes/verify', {
      method: 'POST',
      token: bobToken,
      body: { username: 'bob', code: 'BOB-CODE-01' },
    });
    await api('/api/register', {
      method: 'POST',
      token: bobToken,
      body: { phoneId: 'device-bob', name: 'Борис' },
    });

    const sent = await api('/api/send', {
      method: 'POST',
      token: aliceToken,
      deviceId: 'device-alice',
      body: { to: 'device-bob', text: 'Привет, Борис', data: { type: 'text' } },
    });
    assert.equal(sent.status, 200);
    assert.equal(sent.body.delivery.sent, 1);

    const bobMessages = await api('/api/messages', { token: bobToken, deviceId: 'device-bob' });
    assert.equal(bobMessages.status, 200);
    assert.equal(bobMessages.body.length, 1);
    assert.equal(bobMessages.body[0].text, 'Привет, Борис');
    assert.equal(bobMessages.body[0].from, 'alice');
    assert.equal(typeof bobMessages.body[0].timestamp, 'number');

    const aliceMessages = await api('/api/messages', { token: aliceToken, deviceId: 'device-alice' });
    assert.deepEqual(aliceMessages.body, [], 'the sender should not receive its own server-side copies');

    const chatId = 'c7a40466-a19b-4b2a-8f5e-14ce723fd72a';
    const createdChat = await api('/api/chats', {
      method: 'POST',
      token: aliceToken,
      body: { id: chatId, name: 'Тестовая группа', members: ['alice', 'bob'] },
    });
    assert.equal(createdChat.status, 200);

    const groupMessage = await api('/api/send', {
      method: 'POST',
      token: aliceToken,
      deviceId: 'device-alice',
      body: {
        to: 'all',
        text: 'Только для группы',
        data: { type: 'text', chat_id: chatId },
      },
    });
    assert.equal(groupMessage.status, 200);
    assert.equal(typeof groupMessage.body.timestamp, 'number', 'send returns the server timestamp');

    // Переименование: только создатель.
    assert.equal((await api(`/api/chats/${chatId}`, { method: 'PATCH', token: bobToken, body: { name: 'Чужое' } })).status, 404);
    const renamed = await api(`/api/chats/${chatId}`, { method: 'PATCH', token: aliceToken, body: { name: 'Новое имя' } });
    assert.equal(renamed.status, 200);
    assert.equal((await api('/api/chats', { token: bobToken })).body.find((chat) => chat.id === chatId).name, 'Новое имя');

    // Отметки прочтения: bob прочитал до времени сообщения, alice это видит.
    assert.equal((await api(`/api/chats/${chatId}/read`, {
      method: 'POST', token: bobToken, body: { timestamp: groupMessage.body.timestamp },
    })).status, 200);
    const reads = await api(`/api/chats/${chatId}/reads`, { token: aliceToken });
    assert.equal(reads.body.bob, groupMessage.body.timestamp);
    assert.equal((await api('/api/chats/general/reads', { token: aliceToken })).status, 200);

    // Автоудаление: групповой чат — только создатель, общий — только администратор.
    assert.equal((await api(`/api/chats/${chatId}/auto-delete`, { method: 'PUT', token: bobToken, body: { hours: 1 } })).status, 404);
    assert.equal((await api(`/api/chats/${chatId}/auto-delete`, { method: 'PUT', token: aliceToken, body: { hours: 3 } })).status, 400);
    assert.equal((await api(`/api/chats/${chatId}/auto-delete`, { method: 'PUT', token: aliceToken, body: { hours: 24 } })).status, 200);
    assert.equal((await api('/api/chats/general/auto-delete', { method: 'PUT', token: aliceToken, body: { hours: 1 } })).status, 404);
    assert.equal((await api('/api/chats/general/auto-delete', { method: 'PUT', token: adminToken, body: { hours: 48 } })).status, 200);
    const settings = await api('/api/chats/settings', { token: bobToken });
    assert.equal(settings.body[chatId], 24);
    assert.equal(settings.body.general, 48);
    assert.equal((await api('/api/chats', { token: bobToken })).body.find((chat) => chat.id === chatId).autoDeleteHours, 24);
    assert.equal((await api('/api/chats/general/auto-delete', { method: 'PUT', token: adminToken, body: { hours: 0 } })).status, 200);
    // Свежие сообщения при включении автоудаления не пропадают.
    assert.ok((await api('/api/messages', { token: bobToken, deviceId: 'device-bob' })).body.some((m) => m.text === 'Только для группы'));

    // Пользователи: позывной (или логин) и признак «в сети».
    const usersList = await api('/api/users', { token: aliceToken });
    assert.equal(usersList.status, 200);
    const bobEntry = usersList.body.find((user) => user.username === 'bob');
    assert.ok(bobEntry && bobEntry.isOnline === true && bobEntry.callsign === 'bob');

    // Профиль (позывной, должность, подразделение) хранится на сервере у пользователя.
    assert.equal((await api('/api/register', {
      method: 'POST', token: aliceToken,
      body: { phoneId: 'device-alice', name: 'Pixel', callsign: 'Альфа', position: 'Командир', unit: '1 взвод' },
    })).status, 200);
    // Пустые поля при повторной регистрации не затирают профиль.
    await api('/api/register', { method: 'POST', token: aliceToken, body: { phoneId: 'device-alice', callsign: '' } });
    const aliceUser = (await api('/api/users', { token: bobToken })).body.find((user) => user.username === 'alice');
    assert.deepEqual([aliceUser.callsign, aliceUser.position, aliceUser.unit], ['Альфа', 'Командир', '1 взвод']);

    assert.equal((await api('/api/admin/users/details', { token: aliceToken })).status, 403);
    const details = await api('/api/admin/users/details', { token: adminToken });
    assert.equal(details.status, 200);
    const aliceDetails = details.body.find((user) => user.username === 'alice');
    assert.equal(aliceDetails.unit, '1 взвод');
    assert.equal(aliceDetails.devices, 1);
    assert.equal(details.body.find((user) => user.username === 'admin').admin, true);
    const messagesAfterGroupSend = await api('/api/messages', { token: bobToken, deviceId: 'device-bob' });
    assert.equal(messagesAfterGroupSend.body.length, 2);
    assert.equal(messagesAfterGroupSend.body[1].text, 'Только для группы');
    assert.equal((await api('/api/messages', { token: aliceToken, deviceId: 'device-alice' })).body.length, 0);

    const attachmentText = 'A'.repeat(10 * 1024 * 1024);
    const attachment = await api('/api/send', {
      method: 'POST',
      token: aliceToken,
      deviceId: 'device-alice',
      body: {
        to: 'all',
        text: attachmentText,
        data: { type: 'text', chat_id: 'general', has_attachment: true },
      },
    });
    assert.equal(attachment.status, 200);
    const receivedAttachment = await api('/api/messages', { token: bobToken, deviceId: 'device-bob' });
    assert.equal(receivedAttachment.body[2].text.length, attachmentText.length);

    // ?after=<id> отдаёт только более новые сообщения.
    const firstId = receivedAttachment.body[0].id;
    const newer = await api(`/api/messages?after=${firstId}`, { token: bobToken, deviceId: 'device-bob' });
    assert.deepEqual(newer.body.map((message) => message.id), receivedAttachment.body.slice(1).map((m) => m.id));
    const lastId = receivedAttachment.body[2].id;
    assert.deepEqual((await api(`/api/messages?after=${lastId}`, { token: bobToken, deviceId: 'device-bob' })).body, []);

    const alicePhones = await api('/api/phones', { token: aliceToken, deviceId: 'device-alice' });
    assert.equal(alicePhones.status, 200);
    assert.deepEqual(alicePhones.body.map((phone) => phone.id), ['device-bob']);
    assert.equal(alicePhones.body[0].username, 'bob');
    assert.equal(alicePhones.body[0].callsign, 'bob', 'without a callsign the username is shown, not the device id');

    // Удаление чата: только создатель; чат и его сообщения пропадают у всех участников.
    assert.equal((await api(`/api/chats/${chatId}`, { method: 'DELETE', token: bobToken })).status, 404);
    assert.equal((await api(`/api/chats/${chatId}`, { method: 'DELETE', token: aliceToken })).status, 200);
    assert.ok(!(await api('/api/chats', { token: bobToken })).body.some((chat) => chat.id === chatId));
    const bobAfterChatDelete = await api('/api/messages', { token: bobToken, deviceId: 'device-bob' });
    assert.ok(!bobAfterChatDelete.body.some((message) => message.text === 'Только для группы'));
    assert.equal((await api(`/api/chats/${chatId}`, { method: 'DELETE', token: aliceToken })).status, 404);

    const adminUsers = await api('/api/admin/users', { token: adminToken });
    assert.equal(adminUsers.status, 200);
    assert.ok(adminUsers.body.includes('alice'));
    assert.ok(adminUsers.body.includes('bob'));
    assert.equal((await api('/api/admin/users', { token: aliceToken })).status, 403);

    const deleted = await api('/api/admin/users/bob', { method: 'DELETE', token: adminToken });
    assert.equal(deleted.status, 200);
    assert.ok(!(await api('/api/admin/users', { token: adminToken })).body.includes('bob'));
    assert.ok((await api('/api/users/deleted', { token: adminToken })).body.includes('bob'));
    assert.equal((await api('/api/auth/dev', {
      method: 'POST',
      body: { username: 'bob', passwordHash: sha256('BobPass12') },
    })).status, 410);
  });

  it('rejects a wrong code, unknown device and control data', async () => {
    const token = await devLogin('carol', 'CarolPass1');

    const wrongCode = await api('/api/registration-codes/verify', {
      method: 'POST',
      token,
      body: { username: 'carol', code: 'WRONG-CODE' },
    });
    assert.equal(wrongCode.status, 403);

    const adminToken = await devLogin('admin', 'demo-admin-pass');
    await api('/api/registration-codes', {
      method: 'POST',
      token: adminToken,
      body: { username: 'carol', code: 'CAROL-CODE' },
    });
    await api('/api/registration-codes/verify', {
      method: 'POST',
      token,
      body: { username: 'carol', code: 'CAROL-CODE' },
    });

    const noDevice = await api('/api/send', {
      method: 'POST',
      token,
      deviceId: 'missing-device',
      body: { to: 'all', text: 'test', data: { type: 'text' } },
    });
    assert.equal(noDevice.status, 403);

    await api('/api/register', {
      method: 'POST',
      token,
      body: { phoneId: 'device-carol', name: 'Кэрол' },
    });
    const controlData = await api('/api/send', {
      method: 'POST',
      token,
      deviceId: 'device-carol',
      body: { to: 'all', text: 'legacy', data: { type: 'webrtc_signal' } },
    });
    assert.equal(controlData.status, 400);
  });

  it('issues ICE servers for a registered device', async () => {
    const token = await devLogin('dave', 'DavePass12');
    const adminToken = await devLogin('admin', 'demo-admin-pass');
    await api('/api/registration-codes', {
      method: 'POST',
      token: adminToken,
      body: { username: 'dave', code: 'DAVE-CODE' },
    });
    await api('/api/registration-codes/verify', {
      method: 'POST',
      token,
      body: { username: 'dave', code: 'DAVE-CODE' },
    });
    await api('/api/register', {
      method: 'POST',
      token,
      body: { phoneId: 'device-dave', name: 'Дэйв' },
    });

    const ice = await api('/api/rtc/ice-servers', { token, deviceId: 'device-dave' });
    assert.equal(ice.status, 200);
    assert.ok(Array.isArray(ice.body.iceServers));
    assert.ok(ice.body.iceServers[0].urls.includes('stun:stun.l.google.com:19302'));
  });

  it('records alert acknowledgements and shows them to the administrator', async () => {
    const adminToken = await devLogin('admin', 'demo-admin-pass');
    const token = await devLogin('dave', 'DavePass12');
    const alertKey = 'a1b2c3d4e5f60718a9b0c1d2e3f40516';

    const ack = await api(`/api/alerts/${alertKey}/ack`, {
      method: 'POST', token, deviceId: 'device-dave', body: { ack: true },
    });
    assert.equal(ack.status, 200);
    assert.equal(ack.body.username, 'dave');

    const acks = await api(`/api/alerts/${alertKey}/acks`, { token: adminToken });
    assert.equal(acks.status, 200);
    assert.ok(acks.body.some((row) => row.username === 'dave'), 'admin sees the acknowledgement');

    const forbidden = await api(`/api/alerts/${alertKey}/acks`, { token });
    assert.equal(forbidden.status, 403, 'non-admin cannot read the acknowledgement list');
  });

  it('keeps the last location of each user and returns it to others', async () => {
    const token = await devLogin('dave', 'DavePass12');
    const put = await api('/api/location', {
      method: 'POST', token, deviceId: 'device-dave', body: { lat: 53.9, lng: 27.56, callsign: 'Дэйв' },
    });
    assert.equal(put.status, 200);

    const list = await api('/api/locations', { token });
    assert.equal(list.status, 200);
    const dave = list.body.find((row) => row.username === 'dave');
    assert.ok(dave, 'dave location is stored');
    assert.equal(dave.callsign, 'Дэйв');
    assert.equal(dave.lat, 53.9);

    const invalid = await api('/api/location', {
      method: 'POST', token, deviceId: 'device-dave', body: { lat: 200, lng: 27 },
    });
    assert.equal(invalid.status, 400);
  });

  it('keeps the callsign of a position when the client sends an empty one', async () => {
    const adminToken = await devLogin('admin', 'demo-admin-pass');
    const token = await devLogin('erin', 'ErinPass12');
    await api('/api/registration-codes', {
      method: 'POST', token: adminToken, body: { username: 'erin', code: 'ERIN-CODE' },
    });
    await api('/api/registration-codes/verify', {
      method: 'POST', token, body: { username: 'erin', code: 'ERIN-CODE' },
    });
    await api('/api/register', {
      method: 'POST', token, body: { phoneId: 'device-erin', name: 'Pixel', callsign: 'Гроза' },
    });

    // Пустой позывной в позиции не должен превращать маркер на карте в логин.
    const first = await api('/api/location', {
      method: 'POST', token, deviceId: 'device-erin', body: { lat: 53.1, lng: 27.2, callsign: '' },
    });
    assert.equal(first.status, 200);
    assert.equal(first.body.callsign, 'Гроза', 'callsign taken from the device profile');
    const second = await api('/api/location', {
      method: 'POST', token, deviceId: 'device-erin', body: { lat: 53.2, lng: 27.3 },
    });
    assert.equal(second.body.callsign, 'Гроза', 'previous callsign is kept');
  });

  it('creates, renames and deletes mark layers shared by the unit', async () => {
    const adminToken = await devLogin('admin', 'demo-admin-pass');
    const token = await devLogin('dave', 'DavePass12');

    const initial = await api('/api/mark-layers', { token });
    assert.equal(initial.status, 200);
    assert.ok(initial.body.some((layer) => layer.name === 'Общий'), 'the default layer always exists');

    const created = await api('/api/mark-layers', { method: 'POST', token, body: { name: 'Разведка' } });
    assert.equal(created.status, 200);
    assert.equal(created.body.name, 'Разведка');
    // Повторное создание и создание чужого — только через администратора; дубль отклоняется.
    assert.equal((await api('/api/mark-layers', { method: 'POST', token, body: { name: 'разведка' } })).status, 409);
    assert.equal((await api('/api/mark-layers', { method: 'POST', token, body: { name: '' } })).status, 400);

    const markId = '5b0e5b52-4a1f-4f0e-9a49-7d1a7f6a1a11';
    const mark = await api('/api/marks', {
      method: 'POST',
      token,
      body: { id: markId, type: 'Наблюдательный пункт', label: 'НП-1', lat: 53.9, lng: 27.5, icon: 'builtin:op', layer: 'Разведка' },
    });
    assert.equal(mark.status, 200);
    assert.equal(mark.body.layer, 'Разведка');

    const renamed = await api(`/api/mark-layers/${created.body.id}`, {
      method: 'PATCH', token, body: { name: 'Разведка 2' },
    });
    assert.equal(renamed.status, 200);
    const marks = await api('/api/marks', { token });
    assert.equal(marks.body.find((row) => row.id === markId).layer, 'Разведка 2', 'marks follow the renamed layer');

    // Чужой слой: dave — единственный автор слоя, поэтому удаление его же токеном
    // проходит, а повторное удаление уже нечего удалять.
    assert.equal((await api(`/api/mark-layers/${created.body.id}`, { method: 'DELETE', token })).status, 200);
    assert.equal((await api(`/api/mark-layers/${created.body.id}`, { method: 'DELETE', token: adminToken })).status, 404);
    const afterDelete = await api('/api/marks', { token });
    assert.equal(afterDelete.body.find((row) => row.id === markId).layer, 'Общий', 'marks move to the default layer');
    const defaultLayer = (await api('/api/mark-layers', { token })).body.find((layer) => layer.name === 'Общий');
    assert.equal((await api(`/api/mark-layers/${defaultLayer.id}`, { method: 'DELETE', token: adminToken })).status, 400);

    // withMarks=delete убирает знаки вместе со слоем.
    const doomed = await api('/api/mark-layers', { method: 'POST', token, body: { name: 'Временный' } });
    await api('/api/marks', {
      method: 'POST',
      token,
      body: { id: '6c1f6c63-5b20-4a1f-8b5a-8e2b8f7b2b22', type: 'Точка', lat: 53.5, lng: 27.4, layer: 'Временный' },
    });
    const removed = await api(`/api/mark-layers/${doomed.body.id}?withMarks=delete`, { method: 'DELETE', token });
    assert.equal(removed.status, 200);
    assert.equal(removed.body.affectedMarks, 1);
    assert.ok(!(await api('/api/marks', { token })).body.some((row) => row.id === '6c1f6c63-5b20-4a1f-8b5a-8e2b8f7b2b22'));
  });
});
