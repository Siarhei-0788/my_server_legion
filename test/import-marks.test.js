'use strict';

/**
 * Смоук-тест импорта тактических знаков «как в AlpineQuest».
 *
 * Проверяет контракт, из-за которого импорт раньше не работал:
 *  1) сервер принимает значки из KML/GPX/KMZ (раньше regex отклонял «Summit.png», «Гора»);
 *  2) метки с custom:<id> и встроенными ключами сохраняются пачкой;
 *  3) после импорта знаки видны другим устройствам через GET /api/marks, а значок —
 *     через GET /api/marks/icons/<id> (картинка, которую нарисовал клиент).
 *
 * Запуск: node test/import-marks.test.js
 */

const { after, before, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const path = require('node:path');

const PORT = 3197;
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

async function api(pathname, { method = 'GET', token, body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
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

/** 1×1 PNG — минимальная «картинка значка» из KMZ. */
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

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

describe('tactical marks import (AlpineQuest)', () => {
  it('accepts icons from KML/GPX and shares imported marks with everyone', async () => {
    const adminToken = await devLogin('admin', 'demo-admin-pass');
    const token = await devLogin('alice', 'AlicePass1');
    assert.equal((await api('/api/registration-codes', {
      method: 'POST', token: adminToken, body: { username: 'alice', code: 'ALICE-KML' },
    })).status, 200);
    await api('/api/registration-codes/verify', { method: 'POST', token, body: { username: 'alice', code: 'ALICE-KML' } });
    await api('/api/register', { method: 'POST', token, body: { phoneId: 'device-alice', name: 'Pixel', callsign: 'Альфа' } });

    // Значок из KMZ: сначала картинка на сервер (как делает клиент), затем точки на неё ссылаются.
    const iconId = 'i' + sha256(PNG_BYTES).slice(0, 16);
    const uploaded = await api('/api/marks/icons', {
      method: 'POST', token,
      body: { id: iconId, name: 'Summit', data: PNG_BYTES.toString('base64') },
    });
    assert.equal(uploaded.status, 200, 'PNG-значок из KMZ принимается');

    const icons = await api('/api/marks/icons', { token });
    assert.ok(icons.body.some((icon) => icon.id === iconId && icon.name === 'Summit'));

    // Пачка «как из файла»: ключи разных видов — custom, встроенный, имя файла AlpineQuest, кириллица.
    const imported = await api('/api/marks/batch', {
      method: 'POST', token,
      body: {
        marks: [
          { id: '11111111-1111-4111-8111-111111111111', type: 'Summit', label: 'Гора — высота 197 м',
            lat: 53.9, lng: 27.56, icon: `custom:${iconId}`, layer: 'Импорт KML' },
          { id: '22222222-2222-4222-8222-222222222222', type: 'Наблюдательный пункт', label: 'НП-1',
            lat: 53.91, lng: 27.57, icon: 'builtin:op', layer: 'Импорт KML' },
          { id: '33333333-3333-4333-8333-333333333333', type: 'Flag', label: 'Флаг',
            lat: 53.92, lng: 27.58, icon: 'styles/Flag.png', layer: 'Импорт KML' },
          { id: '44444444-4444-4444-8444-444444444444', type: 'Гора', label: 'Пик',
            lat: 53.93, lng: 27.59, icon: 'Гора', layer: 'Импорт KML' },
        ],
      },
    });
    assert.equal(imported.status, 200, 'пачка точек из файла принимается целиком');
    assert.equal(imported.body.added, 4);

    const marks = await api('/api/marks', { token });
    assert.equal(marks.body.length, 4);
    const summit = marks.body.find((mark) => mark.id === '11111111-1111-4111-8111-111111111111');
    assert.equal(summit.icon, `custom:${iconId}`);
    assert.equal(summit.layer, 'Импорт KML');
    assert.equal(summit.createdBy, 'alice');

    // Второе устройство видит те же знаки и загружает картинку значка.
    const bobToken = await devLogin('bob', 'BobPass12');
    await api('/api/registration-codes', { method: 'POST', token: adminToken, body: { username: 'bob', code: 'BOB-KML' } });
    await api('/api/registration-codes/verify', { method: 'POST', token: bobToken, body: { username: 'bob', code: 'BOB-KML' } });
    const bobMarks = await api('/api/marks', { token: bobToken });
    assert.equal(bobMarks.body.length, 4);
    const icon = await api(`/api/marks/icons/${iconId}`, { token: bobToken });
    assert.equal(icon.status, 200);
    assert.equal(icon.body.data, PNG_BYTES.toString('base64'));
  });

  it('rejects a mark whose icon is not a valid key', async () => {
    const token = await devLogin('alice', 'AlicePass1');
    const response = await api('/api/marks', {
      method: 'POST', token,
      body: { id: '55555555-5555-4555-8555-555555555555', type: 'Точка', lat: 1, lng: 1, icon: '</script>' },
    });
    assert.equal(response.status, 400, 'мусорный ключ значка отклоняется');
  });
});
