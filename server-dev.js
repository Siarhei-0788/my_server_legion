'use strict';

/**
 * LegiON demo server.
 *
 * Полностью повторяет HTTP/Socket.IO-контракт production-сервера (server.js),
 * но не требует Firebase, PostgreSQL, Redis и FCM: всё состояние — в памяти,
 * аутентификация — собственный токен из POST /api/auth/dev.
 *
 * Назначение: демонстрация связки «телефон + ноутбук» на защите и локальная
 * разработка. Для реальной эксплуатации используйте server.js.
 *
 * Запуск:  node server-dev.js           (порт 3000)
 *          PORT=3100 node server-dev.js
 */

const cors = require('cors');
const crypto = require('crypto');
const fs = require('node:fs');
const http = require('http');
const path = require('node:path');
const express = require('express');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT || 3000);
const CALL_TIMEOUT_MS = Number(process.env.RTC_CALL_TIMEOUT_MS || 60_000);
const CODE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_MESSAGES = 5_000;
const MAX_MESSAGE_LENGTH = 12 * 1024 * 1024;
const ADMIN_USERNAME = (process.env.ADMIN_USERNAME || 'admin').toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '123456';
const STUN_URLS = (process.env.STUN_URLS || 'stun:stun.l.google.com:19302')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
// TURN нужен, чтобы звонки проходили через мобильные сети и NAT облачного сервера.
const TURN_URLS = (process.env.TURN_URLS || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const TURN_SHARED_SECRET = process.env.TURN_SHARED_SECRET || '';
const TURN_TTL_SECONDS = Number(process.env.TURN_CREDENTIAL_TTL_SECONDS || 3600);
// Файл состояния: сервер переживает перезапуск и повторный деплой.
// STATE_FILE=off отключает сохранение (нужно тестам).
const STATE_FILE = process.env.STATE_FILE === 'off'
  ? null
  : (process.env.STATE_FILE || path.join(__dirname, 'data', 'state.json'));
const AUTH_RATE_LIMIT = Number(process.env.AUTH_RATE_LIMIT || 30);

if (Boolean(TURN_URLS.length) !== Boolean(TURN_SHARED_SECRET)) {
  throw new Error('Set TURN_URLS and TURN_SHARED_SECRET together');
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true }, maxHttpBufferSize: 512 * 1024 });

app.use(cors());
app.use(express.json({ limit: '16mb' }));

// ---------------------------------------------------------------------------
// Состояние
// ---------------------------------------------------------------------------

/** username -> {username, passwordHash, admin, access, createdAt} */
const users = new Map();
/** token -> username */
const tokens = new Map();
/** username -> {code, expiresAt} */
const codes = new Map();
/** phoneId -> {phoneId, username, name, lastSeen} */
const devices = new Map();
/** remote chat id -> {id, name, createdBy, members} */
const chats = new Map();
const deletedUsers = new Set();
/** {id, fromPhone, toPhone, fromName, text, data, timestamp} */
const messages = [];
/** callId -> {caller, target, type, status, timer} */
const calls = new Map();
/** remote chat id ('general' тоже) -> { username -> серверное время последнего прочитанного } */
const chatReads = new Map();
/** remote chat id ('general' тоже) -> часы автоудаления сообщений (0 — выключено) */
const chatAutoDelete = new Map();
const AUTO_DELETE_HOURS = [0, 1, 5, 12, 24, 48];
/** id -> {id, type, label, lat, lng, icon, createdBy, createdAt} — тактические знаки, общие для всех */
const tacticalMarks = new Map();
/** id -> {id, name, data (PNG base64), createdBy} — значки, импортированные пользователями */
const tacticalIcons = new Map();
const MAX_ICON_BYTES = 100 * 1024;
/** Слой тактических знаков по умолчанию (поле mark.layer). */
const DEFAULT_MARK_LAYER = 'Общий';
/** id -> {id, name, order, createdBy, createdAt} — слои знаков, общие для подразделения */
const tacticalLayers = new Map();

let nextMessageId = 1;

/** Последняя позиция каждого пользователя (заполняется ниже, читается функциями
 *  онлайна и сохранения состояния — объявлена до первого обращения к ней). */
const userLocations = new Map(); // username -> { username, callsign, lat, lng, updatedAt }

// ---------------------------------------------------------------------------
// Утилиты
// ---------------------------------------------------------------------------

const sha256 = (value) => crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
const norm = (value) => String(value == null ? '' : value).trim().toLowerCase();
const now = () => Date.now();

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

// ---------------------------------------------------------------------------
// Сохранение состояния
// ---------------------------------------------------------------------------

function loadState() {
  if (!STATE_FILE) return;
  try {
    const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    for (const user of data.users || []) users.set(norm(user.username), user);
    for (const [token, username] of data.tokens || []) tokens.set(token, username);
    for (const [code, entry] of data.codes || []) codes.set(code, entry);
    for (const device of data.devices || []) devices.set(device.phoneId, device);
    for (const chat of data.chats || []) chats.set(chat.id, chat);
    for (const username of data.deletedUsers || []) deletedUsers.add(norm(username));
    for (const message of data.messages || []) messages.push(message);
    for (const [chatId, reads] of data.chatReads || []) chatReads.set(chatId, reads);
    for (const [chatId, hours] of data.chatAutoDelete || []) chatAutoDelete.set(chatId, hours);
    for (const row of data.userLocations || []) userLocations.set(norm(row.username), row);
    for (const row of data.pushHistory || []) pushHistory.push(row);
    for (const mark of data.tacticalMarks || []) tacticalMarks.set(mark.id, { layer: DEFAULT_MARK_LAYER, ...mark });
    for (const layer of data.tacticalLayers || []) tacticalLayers.set(layer.id, layer);
    for (const icon of data.tacticalIcons || []) tacticalIcons.set(icon.id, icon);
    nextMessageId = Number(data.nextMessageId) || messages.length + 1;
    log(`state loaded: users=${users.size} devices=${devices.size} messages=${messages.length}`);
  } catch (error) {
    if (error.code !== 'ENOENT') log('state load failed:', error.message);
  }
}

let saveTimer = null;

function scheduleSave() {
  if (!STATE_FILE || saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveState();
  }, 500);
  if (typeof saveTimer.unref === 'function') saveTimer.unref();
}

function saveState() {
  if (!STATE_FILE) return;
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      users: [...users.values()],
      tokens: [...tokens.entries()],
      codes: [...codes.entries()],
      devices: [...devices.values()],
      chats: [...chats.values()],
      deletedUsers: [...deletedUsers],
      messages,
      nextMessageId,
      chatReads: [...chatReads.entries()],
      chatAutoDelete: [...chatAutoDelete.entries()],
      userLocations: [...userLocations.values()],
      pushHistory: pushHistory.slice(-10),
      tacticalMarks: [...tacticalMarks.values()],
      tacticalLayers: [...tacticalLayers.values()],
      tacticalIcons: [...tacticalIcons.values()],
    }));
  } catch (error) {
    log('state save failed:', error.message);
  }
}

// Простое ограничение попыток входа: сервер в интернете, перебор паролей не нужен.
const authAttempts = new Map();

/** Демо-push (POST /api/push): клиенты игнорируют уже доставленное после перезапуска. */
const pushHistory = [];
const MAX_PUSH_HISTORY = 50;

function authRateLimited(ip) {
  const key = ip || 'unknown';
  const at = now();
  const entry = authAttempts.get(key);
  if (!entry || entry.resetAt < at) {
    authAttempts.set(key, { count: 1, resetAt: at + 60_000 });
    return false;
  }
  entry.count += 1;
  return entry.count > AUTH_RATE_LIMIT;
}

function seedAdmin() {
  const previous = users.get(ADMIN_USERNAME) || {};
  users.set(ADMIN_USERNAME, {
    ...previous, // профиль (позывной, должность, подразделение) переживает перезапуск
    username: ADMIN_USERNAME,
    passwordHash: sha256(ADMIN_PASSWORD),
    admin: true,
    access: true,
    createdAt: previous.createdAt || now(),
  });

  app.get('/api/users', authenticate, requireAccess, (req, res) => {
    const byUser = new Map();
    for (const device of devices.values()) {
      const username = norm(device.username);
      if (!username || deletedUsers.has(username)) continue;
      const userDevices = [...devices.values()].filter((d) => norm(d.username) === username);
      const online = userOnline(userDevices);
      const profile = users.get(username)?.profile || {};
      const entry = byUser.get(username) || {
        username, callsign: profile.callsign || '', position: profile.position || '', unit: profile.unit || '', isOnline: false,
      };
      if (!entry.callsign && device.callsign) entry.callsign = device.callsign;
      entry.isOnline = entry.isOnline || online;
      byUser.set(username, entry);
    }
    res.json([...byUser.values()]
      .map((entry) => ({ ...entry, callsign: entry.callsign || entry.username }))
      .sort((a, b) => a.callsign.localeCompare(b.callsign)));
  });

  // Для панели администратора: все пользователи с доступом, включая тех, кто ещё
  // не подключал устройство, — со структурированным профилем и статусом.
  app.get('/api/admin/users/details', authenticate, requireAccess, requireAdmin, (req, res) => {
    const list = [];
    for (const user of users.values()) {
      const username = norm(user.username);
      if (user.access !== true || deletedUsers.has(username)) continue;
      const userDevices = [...devices.values()].filter((device) => norm(device.username) === username);
      const profile = user.profile || {};
      list.push({
        username,
        callsign: profile.callsign || userDevices.find((device) => device.callsign)?.callsign || username,
        position: profile.position || '',
        unit: profile.unit || '',
        admin: user.admin === true,
        isOnline: userOnline(userDevices),
        lastSeen: userDevices.length
          ? new Date(Math.max(...userDevices.map((d) => d.lastSeen || 0))).toISOString()
          : null,
        devices: userDevices.length,
      });
    }
    list.sort((a, b) => (a.unit || '\uffff').localeCompare(b.unit || '\uffff') || a.callsign.localeCompare(b.callsign));
    res.json(list);
  });

  app.get('/api/users/deleted', authenticate, requireAccess, (req, res) => {
    res.json([...deletedUsers].sort());
  });

  app.get('/api/admin/users', authenticate, requireAccess, requireAdmin, (req, res) => {
    res.json([...users.values()]
      .filter((user) => user.access === true && !deletedUsers.has(norm(user.username)))
      .map((user) => norm(user.username))
      .sort());
  });

  app.get('/api/chats', authenticate, requireAccess, (req, res) => {
    const username = norm(req.user.username);
    res.json([...chats.values()]
      .filter((chat) => chat.members.includes(username))
      .map((chat) => ({ ...chat, autoDeleteHours: chatAutoDelete.get(chat.id) || 0 })));
  });

  // Автоудаление: настройки всех доступных чатов, включая общий — {chatId: часы}.
  app.get('/api/chats/settings', authenticate, requireAccess, (req, res) => {
    const username = norm(req.user.username);
    const result = { general: chatAutoDelete.get('general') || 0 };
    for (const chat of chats.values()) {
      if (chat.members.includes(username)) result[chat.id] = chatAutoDelete.get(chat.id) || 0;
    }
    res.json(result);
  });

  // Меняет создатель группового чата; общий чат — администратор.
  app.put('/api/chats/:id/auto-delete', authenticate, requireAccess, (req, res) => {
    const chatId = req.params.id;
    const username = norm(req.user.username);
    const allowed = chatId === 'general'
      ? req.user.admin === true
      : chats.get(chatId)?.createdBy === username;
    if (!allowed) return res.status(404).json({ error: 'Chat not found or not managed by this account' });
    const hours = Number(req.body && req.body.hours);
    if (!AUTO_DELETE_HOURS.includes(hours)) return res.status(400).json({ error: 'hours must be one of 0, 1, 5, 12, 24, 48' });
    if (hours === 0) chatAutoDelete.delete(chatId);
    else chatAutoDelete.set(chatId, hours);
    purgeAutoDeleted();
    scheduleSave();
    res.json({ id: chatId, autoDeleteHours: hours });
  });

  app.post('/api/chats', authenticate, requireAccess, (req, res) => {
    const { id, name, members } = req.body || {};
    const username = norm(req.user.username);
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id) ||
        typeof name !== 'string' || !name.trim() || name.trim().length > 80 ||
        !validMembers(members) || members.length < 2) {
      return res.status(400).json({ error: 'Invalid chat details' });
    }
    const normalizedMembers = uniqueMembers(members);
    if (!normalizedMembers.includes(username)) return res.status(403).json({ error: 'Creator must be a chat member' });
    if (normalizedMembers.some((member) => deletedUsers.has(member))) {
      return res.status(409).json({ error: 'A deleted user cannot be added to a chat' });
    }
    const existing = chats.get(id);
    if (existing && existing.createdBy !== username) return res.status(409).json({ error: 'Chat ID is already in use' });
    const chat = { id, name: name.trim(), createdBy: username, members: normalizedMembers };
    chats.set(id, chat);
    scheduleSave();
    res.json(chat);
  });

  // Переименование: создатель или администратор (общий чат не переименовывается).
  app.patch('/api/chats/:id', authenticate, requireAccess, (req, res) => {
    const chat = chats.get(req.params.id);
    const username = norm(req.user.username);
    if (!chat || (chat.createdBy !== username && req.user.admin !== true)) {
      return res.status(404).json({ error: 'Chat not found or not owned by this account' });
    }
    const name = req.body && req.body.name;
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 80) {
      return res.status(400).json({ error: 'Invalid chat name' });
    }
    chat.name = name.trim();
    scheduleSave();
    res.json(chat);
  });

  function validMembers(members) {
    return Array.isArray(members) && members.length <= 100 &&
      members.every((member) => typeof member === 'string' && /^[a-zA-Z0-9._-]{1,64}$/.test(member));
  }

  function uniqueMembers(members) {
    return [...new Set(members.map(norm))];
  }

  /**
   * Состав группового чата: создатель или администратор добавляет и удаляет участников.
   * Список приходит целиком («как в AlpineQuest — галочки»): сервер сам вычисляет,
   * кого добавить и кого убрать. Создателя из чата удалить нельзя.
   */
  app.put('/api/chats/:id/members', authenticate, requireAccess, (req, res) => {
    if (req.params.id === 'general') {
      return res.status(400).json({ error: 'Members of the general chat are all unit members' });
    }
    const chat = chats.get(req.params.id);
    const username = norm(req.user.username);
    if (!chat) return res.status(404).json({ error: 'Chat not found' });
    if (chat.createdBy !== username && req.user.admin !== true) {
      return res.status(403).json({ error: 'Only the creator or an administrator can edit members' });
    }
    const requested = req.body && req.body.members;
    if (!validMembers(requested) || requested.length === 0) {
      return res.status(400).json({ error: 'members must be an array of 1..100 usernames' });
    }
    const next = uniqueMembers(requested);
    if (!next.includes(chat.createdBy)) {
      return res.status(400).json({ error: 'The chat creator must stay a member' });
    }
    if (next.some((member) => deletedUsers.has(member))) {
      return res.status(409).json({ error: 'A deleted user cannot be added to a chat' });
    }
    const added = next.filter((member) => !chat.members.includes(member));
    const removed = chat.members.filter((member) => !next.includes(member));
    chat.members = next;
    scheduleSave();
    io.emit('chats:changed', { chatId: chat.id, added, removed });
    log(`chat ${chat.id}: members updated by ${username} (+${added.length} -${removed.length})`);
    res.json({ ...chat, added, removed });
  });

  // Отметки прочтения: участник сообщает серверное время последнего прочитанного сообщения.
  function canReadChat(chatId, username) {
    if (chatId === 'general') return true;
    const chat = chats.get(chatId);
    return Boolean(chat && chat.members.includes(username));
  }

  app.post('/api/chats/:id/read', authenticate, requireAccess, (req, res) => {
    const username = norm(req.user.username);
    if (!canReadChat(req.params.id, username)) return res.status(404).json({ error: 'Chat not found' });
    const timestamp = Number(req.body && req.body.timestamp);
    if (!Number.isSafeInteger(timestamp) || timestamp <= 0 || timestamp > now() + 60_000) {
      return res.status(400).json({ error: 'Invalid timestamp' });
    }
    const reads = chatReads.get(req.params.id) || {};
    reads[username] = Math.max(reads[username] || 0, timestamp);
    chatReads.set(req.params.id, reads);
    scheduleSave();
    res.json({ status: 'ok' });
  });

  app.get('/api/chats/:id/reads', authenticate, requireAccess, (req, res) => {
    if (!canReadChat(req.params.id, norm(req.user.username))) return res.status(404).json({ error: 'Chat not found' });
    res.json(chatReads.get(req.params.id) || {});
  });

  // Как в production: удалить может создатель или администратор (любой чат); вместе с чатом
  // удаляются его сообщения (включая служебное chat_created, иначе клиент восстановит чат из истории).
  app.delete('/api/chats/:id', authenticate, requireAccess, (req, res) => {
    const chat = chats.get(req.params.id);
    if (!chat || (chat.createdBy !== norm(req.user.username) && req.user.admin !== true)) {
      return res.status(404).json({ error: 'Chat not found or not owned by this account' });
    }
    chats.delete(req.params.id);
    chatReads.delete(req.params.id);
    chatAutoDelete.delete(req.params.id);
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].data?.chat_id === req.params.id) messages.splice(index, 1);
    }
    scheduleSave();
    // Остальные участники узнают об удалении мгновенно (failover: и опросом /api/chats).
    io.emit('chats:changed', { chatId: req.params.id, deleted: true });
    log(`chat ${req.params.id} deleted by ${norm(req.user.username)}`);
    res.json({ status: 'deleted', id: req.params.id });
  });

  app.delete('/api/admin/users/:username', authenticate, requireAccess, requireAdmin, (req, res) => {
    const username = norm(req.params.username);
    if (!/^[a-z0-9._-]{1,64}$/.test(username) || username === ADMIN_USERNAME || username === norm(req.user.username)) {
      return res.status(400).json({ error: 'This user cannot be deleted' });
    }
    users.delete(username);
    for (const [token, owner] of tokens) {
      if (norm(owner) === username) tokens.delete(token);
    }
    for (const [phoneId, device] of devices) {
      if (norm(device.username) === username) devices.delete(phoneId);
    }
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (norm(message.fromUsername || message.fromName) === username || norm(message.data?.username) === username) messages.splice(index, 1);
    }
    for (const [chatId, chat] of chats) {
      chat.members = chat.members.filter((member) => member !== username);
      if (chat.members.length < 2) chats.delete(chatId);
    }
    codes.delete(username);
    deletedUsers.add(username);
    scheduleSave();
    res.json({ status: 'deleted', username });
  });
  if (!process.env.ADMIN_PASSWORD) {
    log(`WARN: demo admin "${ADMIN_USERNAME}" uses the default password; set ADMIN_PASSWORD`);
  }
}

/**
 * «В сети»: сокет открыт, устройство обращалось к серверу последние 2 минуты
 * (фоновая служба опрашивает раз в 10 с) или пришла свежая геолокация за 10 минут —
 * её фоновая служба передаёт даже при закрытом экране.
 */
const LOCATION_ONLINE_MS = 10 * 60_000;

function userOnline(userDevices) {
  const rooms = io.sockets?.adapter?.rooms;
  if (rooms) {
    for (const device of userDevices) {
      if (rooms.get(`phone:${device.phoneId}`)?.size) return true;
    }
  }
  const lastSeen = userDevices.reduce((max, d) => Math.max(max, d.lastSeen || 0), 0);
  if (lastSeen > 0 && now() - lastSeen < 2 * 60_000) return true;
  const deviceForUser = userDevices[0];
  if (deviceForUser) {
    const loc = userLocations.get(norm(deviceForUser.username));
    if (loc && now() - loc.updatedAt < LOCATION_ONLINE_MS) return true;
  }
  return false;
}

function issueToken(username) {
  const token = crypto.randomBytes(24).toString('hex');
  tokens.set(token, norm(username));
  scheduleSave();
  return token;
}

function authenticate(req, res, next) {
  const header = req.get('authorization') || '';
  const match = /^Bearer ([^\s]+)$/.exec(header);
  const username = match && tokens.get(match[1]);
  if (!username) return res.status(401).json({ error: 'Authentication required' });
  const user = users.get(username);
  if (!user) return res.status(401).json({ error: 'Authentication required' });
  req.user = user;
  req.token = match[1];
  return next();
}

function requireAccess(req, res, next) {
  if (req.user.access !== true) {
    return res.status(403).json({ error: 'Account is not enabled for this service' });
  }
  return next();
}

function requireAdmin(req, res, next) {
  if (req.user.admin !== true) return res.status(403).json({ error: 'Administrator access required' });
  return next();
}

function currentDevice(req) {
  const phoneId = req.get('x-device-id');
  const device = phoneId && devices.get(phoneId);
  if (!device || norm(device.username) !== norm(req.user.username)) return null;
  device.lastSeen = now();
  return device;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Аутентификация (демонстрационная)
// ---------------------------------------------------------------------------

app.post('/api/auth/dev', (req, res) => {
  if (authRateLimited(req.ip)) {
    return res.status(429).json({ error: 'too_many_requests' });
  }
  if (!isRecord(req.body)) return res.status(400).json({ error: 'Request body must be a JSON object' });
  const { username, passwordHash } = req.body;
  if (typeof username !== 'string' || !/^[a-zA-Z0-9._-]{3,64}$/.test(username.trim())) {
    return res.status(400).json({ error: 'invalid_username' });
  }
  if (typeof passwordHash !== 'string' || !/^[a-f0-9]{64}$/i.test(passwordHash)) {
    return res.status(400).json({ error: 'invalid_password_hash' });
  }

  const key = norm(username);
  if (deletedUsers.has(key)) return res.status(410).json({ error: 'user_deleted' });
  let user = users.get(key);
  if (!user) {
    user = { username: username.trim(), passwordHash: passwordHash.toLowerCase(), admin: false, access: false, createdAt: now() };
    users.set(key, user);
    log('demo user created:', user.username);
  } else if (user.passwordHash !== passwordHash.toLowerCase()) {
    return res.status(401).json({ error: 'invalid_credentials' });
  }

  return res.json({
    token: issueToken(user.username),
    user: { username: user.username, admin: Boolean(user.admin), access: Boolean(user.access) },
  });
});

app.post('/api/logout', authenticate, (req, res) => {
  tokens.delete(req.token);
  scheduleSave();
  res.json({ status: 'ok' });
});

// ---------------------------------------------------------------------------
// Коды регистрации
// ---------------------------------------------------------------------------

app.post('/api/registration-codes', authenticate, requireAccess, requireAdmin, (req, res) => {
  const { username, code } = req.body || {};
  if (typeof username !== 'string' || !/^[a-zA-Z0-9._-]{1,64}$/.test(username) ||
      typeof code !== 'string' || !/^[a-zA-Z0-9-]{6,32}$/.test(code)) {
    return res.status(400).json({ error: 'Invalid username or registration code' });
  }
  if (deletedUsers.has(norm(username))) return res.status(410).json({ error: 'This username has been permanently deleted' });
  codes.set(norm(username), { code: code.toUpperCase(), expiresAt: now() + CODE_TTL_MS });
  scheduleSave();
  log(`registration code issued for ${username}`);
  res.json({ status: 'ok', expiresInSeconds: CODE_TTL_MS / 1000 });
});

app.post('/api/registration-codes/verify', authenticate, (req, res) => {
  const { username, code } = req.body || {};
  if (typeof username !== 'string' || typeof code !== 'string') {
    return res.status(400).json({ error: 'Invalid username or registration code' });
  }
  const key = norm(username);
  if (key !== norm(req.user.username)) {
    return res.status(403).json({ error: 'Identity does not match username' });
  }
  const entry = codes.get(key);
  if (!entry || entry.expiresAt < now() || entry.code !== code.trim().toUpperCase()) {
    return res.status(403).json({ error: 'Invalid or expired registration code' });
  }
  codes.delete(key);
  req.user.access = true;
  scheduleSave();
  log(`access granted to ${username}`);
  res.json({ status: 'ok' });
});

// ---------------------------------------------------------------------------
// Устройства и присутствие
// ---------------------------------------------------------------------------

app.post('/api/register', authenticate, requireAccess, (req, res) => {
  const { phoneId, name, fcmToken, callsign, position, unit } = req.body || {};
  for (const [field, value] of [['position', position], ['unit', unit]]) {
    if (value !== undefined && value !== null && (typeof value !== 'string' || value.length > 120)) {
      return res.status(400).json({ error: `${field} must be a string of at most 120 characters` });
    }
  }
  if (typeof phoneId !== 'string' || phoneId.trim().length < 1 || phoneId.trim().length > 128) {
    return res.status(400).json({ error: 'phoneId must be a non-empty string of at most 128 characters' });
  }
  if (name !== undefined && name !== null && (typeof name !== 'string' || name.length > 120)) {
    return res.status(400).json({ error: 'name must be a string of at most 120 characters' });
  }
  if (callsign !== undefined && callsign !== null && (typeof callsign !== 'string' || callsign.length > 120)) {
    return res.status(400).json({ error: 'callsign must be a string of at most 120 characters' });
  }
  const id = phoneId.trim();
  const existing = devices.get(id);
  if (existing && norm(existing.username) !== norm(req.user.username)) {
    return res.status(409).json({ error: 'phoneId is registered to another account' });
  }
  devices.set(id, {
    phoneId: id,
    username: req.user.username,
    name: (name && name.trim()) || 'Android device',
    // Пустой позывной не затирает ранее сохранённый (как в production-сервере).
    callsign: (callsign && callsign.trim()) || existing?.callsign || null,
    fcmToken: fcmToken || null,
    lastSeen: now(),
  });
  // Профиль — у пользователя, а не у устройства. Пустые поля не затирают сохранённые.
  const user = users.get(norm(req.user.username));
  if (user) {
    const profile = user.profile || {};
    if (callsign && callsign.trim()) profile.callsign = callsign.trim();
    if (position && position.trim()) profile.position = position.trim();
    if (unit && unit.trim()) profile.unit = unit.trim();
    user.profile = profile;
  }
  scheduleSave();
  res.json({ status: 'ok', pushEnabled: false, demo: true });
});

// Список устройств подразделения (зарегистрированных через /api/register) — для
// собеседников и координат. История сообщений запрашивается отдельно: без
// X-Device-ID вызову не нужен зарегистрированный телефон.
app.get('/api/phones', authenticate, requireAccess, (req, res) => {
  const list = [...devices.values()]
    .filter((device) => norm(device.username) !== norm(req.user.username))
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .map((device) => publicDevice(device, userOnline([device])));
  res.json(list);
});

app.get('/api/phone/:id', authenticate, requireAccess, (req, res) => {
  const device = devices.get(req.params.id);
  if (!device || norm(device.username) === norm(req.user.username)) {
    return res.status(404).json({ error: 'Phone not found' });
  }
  res.json(publicDevice(device, userOnline([device])));
});

// Позывной нужен клиенту для списка собеседников: без него показывается id устройства.
function publicDevice(device, isOnline) {
  return {
    id: device.phoneId,
    name: device.name,
    username: device.username,
    callsign: device.callsign || device.username,
    lastSeen: new Date(device.lastSeen).toISOString(),
    isOnline,
  };
}

// ---------------------------------------------------------------------------
// Сообщения
// ---------------------------------------------------------------------------

app.post('/api/send', authenticate, requireAccess, (req, res) => {
  const device = currentDevice(req);
  if (!device) return res.status(403).json({ error: 'Device is not registered to this account' });
  const { to, text, data } = req.body || {};
  if (typeof text !== 'string' || text.trim().length === 0 || text.length > MAX_MESSAGE_LENGTH) {
    return res.status(400).json({ error: `text must contain 1 to ${MAX_MESSAGE_LENGTH} characters` });
  }
  if (!isRecord(data) || Buffer.byteLength(JSON.stringify(data)) > 8000) {
    return res.status(400).json({ error: 'data must be a JSON object no larger than 8 KB' });
  }
  if (['user_account', 'registration_code', 'webrtc_signal'].includes(data.type)) {
    return res.status(400).json({ error: 'Sensitive control data cannot be sent as chat messages' });
  }
  const recipient = typeof to === 'string' && to !== 'all' ? to : null;
  if (recipient && !devices.has(recipient)) {
    return res.status(404).json({ error: 'Target device not found' });
  }

  let targets;
  // Любое сообщение с chat_id (текст, файл, аудио, изображение) — участникам этого чата.
  if (data.type === 'text' || typeof data.chat_id === 'string') {
    const chatId = typeof data.chat_id === 'string' ? data.chat_id : 'general';
    if (chatId === 'general') {
      targets = [...devices.values()]
        .filter((item) => item.phoneId !== device.phoneId && norm(item.username) !== norm(req.user.username))
        .map((item) => item.phoneId);
    } else {
      const chat = chats.get(chatId);
      if (!chat || !chat.members.includes(norm(req.user.username))) {
        return res.status(403).json({ error: 'Not a member of this chat' });
      }
      targets = [...devices.values()]
        .filter((item) => item.phoneId !== device.phoneId && chat.members.includes(norm(item.username)))
        .map((item) => item.phoneId);
    }
  } else {
    targets = recipient
      ? [recipient]
      : [...devices.values()].filter((item) => item.phoneId !== device.phoneId).map((item) => item.phoneId);
  }

  const sentAt = now();
  for (const target of targets) {
    messages.push({
      id: nextMessageId++,
      fromPhone: device.phoneId,
      fromUsername: req.user.username,
      toPhone: target,
      fromName: device.name,
      text: text.trim(),
      data,
      timestamp: sentAt,
    });
  }
  if (messages.length > MAX_MESSAGES) messages.splice(0, messages.length - MAX_MESSAGES);
  scheduleSave();

  // timestamp — серверное время сообщения: клиент сравнивает с ним отметки прочтения.
  res.json({ status: 'ok', timestamp: sentAt, delivery: { sent: targets.length, failed: 0, demo: true } });
});

app.get('/api/messages', authenticate, requireAccess, (req, res) => {
  const device = currentDevice(req);
  if (!device) return res.status(403).json({ error: 'Device is not registered to this account' });
  // ?after=<id> — только новые сообщения: клиент опрашивает каждые несколько секунд,
  // и без этого каждый раз заново скачивал бы до 500 сообщений вместе с вложениями.
  const after = Number(req.query.after);
  const list = messages
    .filter((message) => message.toPhone === device.phoneId)
    .filter((message) => !Number.isSafeInteger(after) || after <= 0 || message.id > after)
    .slice(-500)
    .map((message) => ({
      id: String(message.id),
      from: message.fromUsername || message.fromName,
      to: message.toPhone,
      text: message.text,
      data: message.data,
      timestamp: message.timestamp,
    }));
  res.json(list);
});

app.post('/api/push', authenticate, requireAccess, requireAdmin, (req, res) => {
  // В демонстрационном (dev) режиме Firebase не настроен: пуши уходят через сокет
  // (событие push:message) всем подключённым устройствам. Клиент показывает ту же
  // нотификацию, что и в production, — это позволяет проверить настройки
  // уведомлений и канал без облачного проекта.
  const { title, body, data } = req.body || {};
  if (typeof title !== 'string' || !title.trim() || title.length > 120
      || typeof body !== 'string' || body.length > 1000 || (data !== undefined && !isRecord(data))) {
    return res.status(400).json({ error: 'Invalid notification payload' });
  }
  const payload = { title: title.trim(), body, data: data || {}, sentAt: now() };
  pushHistory.push(payload);
  if (pushHistory.length > MAX_PUSH_HISTORY) pushHistory.splice(0, pushHistory.length - MAX_PUSH_HISTORY);
  io.emit('push:message', payload);
  const online = io.sockets?.sockets?.size || 0;
  log(`demo push "${payload.title}" to ${online} socket(s)`);
  scheduleSave();
  res.json({ status: 'ok', demo: true, delivery: { sent: online, failed: 0, channel: 'socket' } });
});

// FCM-токены: в dev-режиме регистрируются и хранятся, чтобы клиент видел, что
// устройство готово к push, но доставка идёт сокетом.
app.post('/api/push/token', authenticate, requireAccess, (req, res) => {
  const { fcmToken } = req.body || {};
  if (typeof fcmToken !== 'string' || fcmToken.length < 10 || fcmToken.length > 4096) {
    return res.status(400).json({ error: 'fcmToken must be a string of 10..4096 characters' });
  }
  const device = devices.get(req.get('x-device-id'));
  if (!device) return res.status(403).json({ error: 'Device is not registered to this account' });
  device.fcmToken = fcmToken;
  device.pushRegisteredAt = now();
  scheduleSave();
  res.json({ status: 'ok', demo: true });
});

// ---------------------------------------------------------------------------
// Тактические знаки: общие для всех, изменения рассылаются по сокету (marks:changed)
// ---------------------------------------------------------------------------

const MARK_ID = /^[0-9a-f-]{36}$/i;
const ICON_ID = /^[a-z0-9_-]{1,64}$/;
/**
 * Ключ значка у знака: builtin:<key>, custom:<iconId>, путь картинки из KMZ
 * («styles/Flag.png»), а также AlpineQuest-имена («Summit.png», «Гора») — их клиент
 * присылает при импорте KML/KMZ. Слэш/обратный слэш разрешены только внутри пути.
 */
const ICON_KEY = /^[\p{L}\p{N}_.: \\/-]{1,120}$/u;

function parseMark(body, username) {
  if (!isRecord(body)) return null;
  const { id, type, label, lat, lng, icon, layer } = body;
  if (typeof id !== 'string' || !MARK_ID.test(id)) return null;
  if (typeof type !== 'string' || !type.trim() || type.length > 60) return null;
  if (label !== undefined && label !== null && (typeof label !== 'string' || label.length > 120)) return null;
  if (typeof lat !== 'number' || typeof lng !== 'number' || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  // Раньше здесь был шаблон ^[a-z0-9_:-]{1,80}$: значки AlpineQuest («Summit.png»,
  // «Гора») и custom:<id> отклоняли всю пачку — импорт не работал вовсе.
  if (icon !== undefined && icon !== null && (typeof icon !== 'string' || !ICON_KEY.test(icon))) return null;
  if (layer !== undefined && layer !== null && (typeof layer !== 'string' || layer.trim().length > 60)) return null;
  const layerName = typeof layer === 'string' && layer.trim() ? layer.trim() : DEFAULT_MARK_LAYER;
  return {
    id: id.toLowerCase(), type: type.trim(), label: (label || '').trim(), lat, lng,
    icon: icon || null, layer: layerName, createdBy: username, createdAt: now(),
  };
}

function marksChanged() {
  scheduleSave();
  io.emit('marks:changed', { at: now() });
}

// ---------------------------------------------------------------------------
// Сборы: подтверждения (в памяти, как и остальное demo-состояние)
// ---------------------------------------------------------------------------

const alertAcks = new Map(); // alertId -> Map(username -> { username, callsign, ackedAt })
const ALERT_KEY = /^[A-Za-z0-9_-]{1,64}$/;

app.post('/api/alerts/:id/ack', authenticate, requireAccess, (req, res) => {
  const alertId = String(req.params.id || '');
  if (!ALERT_KEY.test(alertId)) return res.status(400).json({ error: 'Invalid alert id' });
  const username = norm(req.user.username);
  const callsign = (req.user.name && String(req.user.name).trim()) || username;
  const ackedAt = now();
  if (!alertAcks.has(alertId)) alertAcks.set(alertId, new Map());
  const ack = { alert_id: alertId, username, callsign, ackedAt };
  alertAcks.get(alertId).set(username, ack);
  io.emit('alert:ack', ack);
  res.json(ack);
});

app.get('/api/alerts/:id/acks', authenticate, requireAccess, (req, res) => {
  if (req.user.admin !== true) return res.status(403).json({ error: 'Administrator access required' });
  const alertId = String(req.params.id || '');
  if (!ALERT_KEY.test(alertId)) return res.status(400).json({ error: 'Invalid alert id' });
  const rows = [...(alertAcks.get(alertId) || new Map()).values()].sort((a, b) => a.ackedAt - b.ackedAt);
  res.json(rows.map(({ alert_id, username, callsign, ackedAt }) => ({ alert_id, username, callsign, ackedAt })));
});

// ---------------------------------------------------------------------------
// Позиции пользователей: последняя позиция каждого (Map объявлен выше), обновления — сокетом
// ---------------------------------------------------------------------------

app.post('/api/location', authenticate, requireAccess, (req, res) => {
  const { lat, lng, callsign } = req.body || {};
  if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng)
      || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return res.status(400).json({ error: 'lat and lng must be valid coordinates' });
  }
  const username = norm(req.user.username);
  const previous = userLocations.get(username);
  // Позывной: переданный → сохранённый у устройства/профиля → предыдущий → логин.
  // Раньше при пустом callsign в строке оставался логин, и на карте у всех бойцы
  // подписывались логинами («admin» вместо «Альфа»).
  const callerDevice = devices.get(req.get('x-device-id'));
  const callsignFromProfile = users.get(username)?.profile?.callsign;
  const row = {
    username,
    callsign: (typeof callsign === 'string' && callsign.trim())
      || callerDevice?.callsign
      || callsignFromProfile
      || previous?.callsign
      || username,
    lat, lng, updatedAt: now(),
  };
  userLocations.set(username, row);
  io.emit('location:update', row);
  scheduleSave();
  res.json(row);
});

app.get('/api/locations', authenticate, requireAccess, (req, res) => {
  res.json([...userLocations.values()]);
});

app.get('/api/marks', authenticate, requireAccess, (req, res) => {
  res.json([...tacticalMarks.values()].sort((a, b) => a.createdAt - b.createdAt));
});

app.post('/api/marks', authenticate, requireAccess, (req, res) => {
  const mark = parseMark(req.body, norm(req.user.username));
  if (!mark) return res.status(400).json({ error: 'Invalid mark' });
  if (tacticalMarks.has(mark.id)) return res.json(tacticalMarks.get(mark.id)); // повтор — идемпотентно
  tacticalMarks.set(mark.id, mark);
  marksChanged();
  res.json(mark);
});

// Импорт сразу многих знаков (точки из AlpineQuest KML/GPX).
app.post('/api/marks/batch', authenticate, requireAccess, (req, res) => {
  const list = req.body && req.body.marks;
  if (!Array.isArray(list) || list.length === 0 || list.length > 1000) {
    return res.status(400).json({ error: 'marks must be an array of 1..1000 items' });
  }
  const parsed = list.map((item) => parseMark(item, norm(req.user.username)));
  if (parsed.some((mark) => !mark)) return res.status(400).json({ error: 'Invalid mark in batch' });
  let added = 0;
  for (const mark of parsed) {
    if (!tacticalMarks.has(mark.id)) {
      tacticalMarks.set(mark.id, mark);
      added += 1;
    }
  }
  if (added) marksChanged();
  res.json({ added });
});

// Удалить знак может его автор или администратор.
app.delete('/api/marks/:id', authenticate, requireAccess, (req, res) => {
  const mark = tacticalMarks.get(String(req.params.id).toLowerCase());
  if (!mark) return res.status(404).json({ error: 'Mark not found' });
  if (mark.createdBy !== norm(req.user.username) && req.user.admin !== true) {
    return res.status(403).json({ error: 'Only the author or an administrator can delete this mark' });
  }
  tacticalMarks.delete(mark.id);
  marksChanged();
  res.json({ status: 'deleted', id: mark.id });
});

// ---------------------------------------------------------------------------
// Слои тактических знаков: общие для подразделения (имя, порядок, скрытость по умолчанию).
// Знак ссылается на слой полем layer; слоя без знаков может не быть в /api/marks,
// поэтому список слоёв хранится отдельно — и его видят все устройства.
// ---------------------------------------------------------------------------

const LAYER_NAME_MAX = 60;

function findLayer(name) {
  const key = norm(name);
  if (!key) return null;
  return [...tacticalLayers.values()].find((layer) => norm(layer.name) === key) || null;
}

function ensureLayer(name, username) {
  const existing = findLayer(name) || findLayer(DEFAULT_MARK_LAYER);
  if (existing && norm(existing.name) === norm(name)) return existing;
  const layer = {
    id: crypto.randomUUID(),
    name: String(name).trim().slice(0, LAYER_NAME_MAX),
    order: tacticalLayers.size,
    createdBy: norm(username),
    createdAt: now(),
    hiddenByDefault: false,
  };
  tacticalLayers.set(layer.id, layer);
  return layer;
}

app.get('/api/mark-layers', authenticate, requireAccess, (req, res) => {
  res.json([...tacticalLayers.values()].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name)));
});

app.post('/api/mark-layers', authenticate, requireAccess, (req, res) => {
  const { name } = req.body || {};
  if (typeof name !== 'string' || !name.trim() || name.trim().length > LAYER_NAME_MAX) {
    return res.status(400).json({ error: `Layer name must be 1..${LAYER_NAME_MAX} characters` });
  }
  if (findLayer(name)) return res.status(409).json({ error: 'layer_exists' });
  const layer = ensureLayer(name, req.user.username);
  marksChanged();
  res.json(layer);
});

// Переименование слоя: знаки переезжают вместе с ним.
app.patch('/api/mark-layers/:id', authenticate, requireAccess, (req, res) => {
  const layer = tacticalLayers.get(req.params.id);
  if (!layer) return res.status(404).json({ error: 'Layer not found' });
  const { name } = req.body || {};
  if (typeof name !== 'string' || !name.trim() || name.trim().length > LAYER_NAME_MAX) {
    return res.status(400).json({ error: `Layer name must be 1..${LAYER_NAME_MAX} characters` });
  }
  const clash = findLayer(name);
  if (clash && clash.id !== layer.id) return res.status(409).json({ error: 'layer_exists' });
  const previous = layer.name;
  layer.name = name.trim();
  if (norm(previous) !== norm(layer.name)) {
    for (const mark of tacticalMarks.values()) {
      if (norm(mark.layer) === norm(previous)) mark.layer = layer.name;
    }
  }
  marksChanged();
  res.json(layer);
});

// Удаление слоя. Знаки слоя по умолчанию переносятся в «Общий» (withMarks=delete — удаляются).
// Удалить может автор слоя или администратор; «Общий» удалить нельзя.
app.delete('/api/mark-layers/:id', authenticate, requireAccess, (req, res) => {
  const layer = tacticalLayers.get(req.params.id);
  if (!layer) return res.status(404).json({ error: 'Layer not found' });
  if (norm(layer.name) === norm(DEFAULT_MARK_LAYER)) {
    return res.status(400).json({ error: 'default_layer' });
  }
  if (layer.createdBy !== norm(req.user.username) && req.user.admin !== true) {
    return res.status(403).json({ error: 'Only the author or an administrator can delete this layer' });
  }
  const withMarks = String(req.query.withMarks || 'move');
  if (!['move', 'delete'].includes(withMarks)) {
    return res.status(400).json({ error: 'withMarks must be move or delete' });
  }
  const defaultLayer = ensureLayer(DEFAULT_MARK_LAYER, ADMIN_USERNAME);
  let affected = 0;
  for (const [markId, mark] of tacticalMarks) {
    if (norm(mark.layer) !== norm(layer.name)) continue;
    affected += 1;
    if (withMarks === 'delete') tacticalMarks.delete(markId);
    else mark.layer = defaultLayer.name;
  }
  tacticalLayers.delete(layer.id);
  marksChanged();
  res.json({ status: 'deleted', id: layer.id, affectedMarks: affected, movedTo: withMarks === 'move' ? defaultLayer.name : null });
});

// Пользовательские значки (импорт набора PNG): нужны всем, кто видит знак с таким значком.
app.get('/api/marks/icons', authenticate, requireAccess, (req, res) => {
  res.json([...tacticalIcons.values()].map(({ id, name, createdBy }) => ({ id, name, createdBy })));
});

app.get('/api/marks/icons/:id', authenticate, requireAccess, (req, res) => {
  const icon = tacticalIcons.get(req.params.id);
  if (!icon) return res.status(404).json({ error: 'Icon not found' });
  res.json(icon);
});

app.post('/api/marks/icons', authenticate, requireAccess, (req, res) => {
  const { id, name, data } = req.body || {};
  if (typeof id !== 'string' || !ICON_ID.test(id) || typeof name !== 'string' || !name.trim() || name.length > 60
      || typeof data !== 'string') {
    return res.status(400).json({ error: 'Invalid icon' });
  }
  const bytes = Buffer.from(data, 'base64');
  const isPng = bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (!isPng || bytes.length > MAX_ICON_BYTES) return res.status(400).json({ error: 'Icon must be a PNG up to 100 KB' });
  const existing = tacticalIcons.get(id);
  if (existing && existing.createdBy !== norm(req.user.username)) return res.status(409).json({ error: 'Icon id is taken' });
  tacticalIcons.set(id, { id, name: name.trim(), data, createdBy: norm(req.user.username) });
  marksChanged();
  res.json({ id, name: name.trim() });
});

// ---------------------------------------------------------------------------
// ICE
// ---------------------------------------------------------------------------

app.get('/api/rtc/ice-servers', authenticate, requireAccess, (req, res) => {
  if (!currentDevice(req)) return res.status(403).json({ error: 'Device is not registered to this account' });
  const iceServers = STUN_URLS.length ? [{ urls: STUN_URLS }] : [];
  if (TURN_URLS.length && TURN_SHARED_SECRET) {
    // Временные учётные данные coturn (REST API, HMAC-SHA1) — как в production-сервере.
    const username = `${Math.floor(Date.now() / 1000) + TURN_TTL_SECONDS}:${req.user.username}`;
    const credential = crypto.createHmac('sha1', TURN_SHARED_SECRET).update(username).digest('base64');
    iceServers.push({ urls: TURN_URLS, username, credential });
  }
  res.set('Cache-Control', 'no-store');
  res.json({ iceServers });
});

// ---------------------------------------------------------------------------
// Служебное
// ---------------------------------------------------------------------------

app.get('/health/live', (req, res) => res.json({ status: 'ok' }));
app.get('/health/ready', (req, res) => res.json({ status: 'ready', demo: true, users: users.size, devices: devices.size }));
app.get('/health', (req, res) => res.json({ status: 'ok', demo: true, users: users.size, devices: devices.size, messages: messages.length }));

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  log('http error:', error.message);
  return res.status(500).json({ error: 'Internal server error' });
});

// ---------------------------------------------------------------------------
// Socket.IO: сигналинг WebRTC
// ---------------------------------------------------------------------------

function socketUser(socket) {
  const { idToken, phoneId } = socket.handshake.auth || {};
  if (typeof idToken !== 'string' || typeof phoneId !== 'string') return null;
  const username = tokens.get(idToken);
  if (!username) return null;
  const user = users.get(username);
  const device = devices.get(phoneId);
  if (!user || user.access !== true || !device || norm(device.username) !== username) return null;
  device.lastSeen = now();
  return { user, device };
}

io.use((socket, next) => {
  const context = socketUser(socket);
  if (!context) return next(new Error('unauthorized'));
  socket.data.user = context.user;
  socket.data.device = context.device;
  return next();
});

io.on('connection', (socket) => {
  const { device } = socket.data;
  socket.join(`phone:${device.phoneId}`);
  log('socket connected:', device.phoneId);

  socket.on('disconnect', () => {
    device.lastSeen = now();
    // Экран звонка закрылся/потерял сеть, не отправив rtc:hangup. Без этого звонок
    // висел вечно и оба участника получали user_busy до перезапуска сервера.
    // Смотрим именно на сокет экрана звонка: фоновый сокет (AlertService) живёт всегда.
    for (const [callId, call] of [...calls]) {
      if (call.callerSocket === socket.id || call.targetSocket === socket.id) {
        const peer = call.caller === device.phoneId ? call.target : call.caller;
        finish(callId, 'disconnected', [peer]);
      }
    }
  });

  const reply = (ack, payload) => {
    if (typeof ack === 'function') ack(payload);
  };

  function peerOf(callId) {
    const call = calls.get(callId);
    if (!call) return null;
    const me = device.phoneId;
    if (call.caller !== me && call.target !== me) return null;
    return { call, peer: call.caller === me ? call.target : call.caller };
  }

  function finish(callId, reason, notify) {
    const call = calls.get(callId);
    if (!call) return;
    clearTimeout(call.timer);
    calls.delete(callId);
    for (const phoneId of notify) {
      io.to(`phone:${phoneId}`).emit('rtc:ended', { callId, reason });
    }
  }

  socket.on('rtc:call', (payload, ack) => {
    if (!isRecord(payload)) return reply(ack, { ok: false, error: 'invalid_payload' });
    const { to, callType } = payload;
    if (typeof to !== 'string' || !to || to === device.phoneId || !['audio', 'video'].includes(callType)) {
      return reply(ack, { ok: false, error: 'invalid_call_request' });
    }
    if (!devices.has(to)) return reply(ack, { ok: false, error: 'target_not_registered' });
    // Звонящий начинает новый вызов — значит, его прежние принятые звонки и собственные
    // исходящие уже не идут (зависли без rtc:hangup). Входящий, который ещё звонит, не трогаем.
    for (const [staleId, staleCall] of [...calls]) {
      const mine = staleCall.caller === device.phoneId || staleCall.target === device.phoneId;
      if (mine && (staleCall.status === 'accepted' || staleCall.caller === device.phoneId)) {
        finish(staleId, 'replaced', [staleCall.caller === device.phoneId ? staleCall.target : staleCall.caller]);
      }
    }
    const busy = [...calls.values()].some((call) => call.caller === to || call.target === to);
    if (busy) return reply(ack, { ok: false, error: 'user_busy' });
    // В demo-режиме нет FCM: если у собеседника нет открытого сокета, вызов не дойдёт.
    if (!io.sockets.adapter.rooms.get(`phone:${to}`)?.size) {
      return reply(ack, { ok: false, error: 'target_unreachable' });
    }

    const callId = crypto.randomUUID();
    const call = {
      caller: device.phoneId, target: to, type: callType, status: 'ringing', timer: null,
      callerSocket: socket.id, targetSocket: null,
    };
    call.timer = setTimeout(() => {
      if (call.status === 'ringing') finish(callId, 'timeout', [call.caller, call.target]);
    }, CALL_TIMEOUT_MS);
    calls.set(callId, call);

    io.to(`phone:${to}`).emit('rtc:incoming', {
      callId, from: device.phoneId, fromName: device.callsign || device.username, callType,
    });
    return reply(ack, { ok: true, callId, status: 'ringing' });
  });

  socket.on('rtc:accept', (payload, ack) => {
    const callId = payload && payload.callId;
    const found = callId && peerOf(callId);
    if (!found || found.call.target !== device.phoneId || found.call.status !== 'ringing') {
      return reply(ack, { ok: false, error: 'call_not_available' });
    }
    clearTimeout(found.call.timer);
    found.call.status = 'accepted';
    found.call.targetSocket = socket.id;
    io.to(`phone:${found.peer}`).emit('rtc:accepted', { callId });
    return reply(ack, { ok: true, callId });
  });

  socket.on('rtc:reject', (payload, ack) => {
    const callId = payload && payload.callId;
    const found = callId && peerOf(callId);
    if (!found) return reply(ack, { ok: false, error: 'call_not_available' });
    io.to(`phone:${found.peer}`).emit('rtc:rejected', { callId, reason: 'declined' });
    finish(callId, 'rejected', [found.peer]);
    return reply(ack, { ok: true });
  });

  socket.on('rtc:hangup', (payload, ack) => {
    const callId = payload && payload.callId;
    const found = callId && peerOf(callId);
    if (!found) return reply(ack, { ok: false, error: 'call_not_available' });
    finish(callId, 'hangup', [found.peer]);
    return reply(ack, { ok: true });
  });

  socket.on('rtc:offer', (payload, ack) => forward(payload, ack, 'rtc:offer', 'caller', 'offer'));
  socket.on('rtc:answer', (payload, ack) => forward(payload, ack, 'rtc:answer', 'target', 'answer'));

  socket.on('rtc:ice-candidate', (payload, ack) => {
    const callId = payload && payload.callId;
    const found = callId && peerOf(callId);
    if (!found || found.call.status !== 'accepted') return reply(ack, { ok: false, error: 'call_not_available' });
    const candidate = payload.candidate;
    if (candidate !== null && (!isRecord(candidate) || typeof candidate.candidate !== 'string' ||
        candidate.candidate.length > 16_000)) {
      return reply(ack, { ok: false, error: 'invalid_ice_candidate' });
    }
    io.to(`phone:${found.peer}`).emit('rtc:ice-candidate', { callId, from: device.phoneId, candidate });
    return reply(ack, { ok: true, callId });
  });

  function forward(payload, ack, event, expectedRole, descriptionType) {
    const callId = payload && payload.callId;
    const found = callId && peerOf(callId);
    if (!found || found.call.status !== 'accepted') return reply(ack, { ok: false, error: 'call_not_available' });
    const role = found.call.caller === device.phoneId ? 'caller' : 'target';
    const description = payload.description;
    if (role !== expectedRole || !isRecord(description) || description.type !== descriptionType ||
        typeof description.sdp !== 'string' || description.sdp.length > 256_000) {
      return reply(ack, { ok: false, error: `invalid_${descriptionType}` });
    }
    io.to(`phone:${found.peer}`).emit(event, { callId, from: device.phoneId, description });
    return reply(ack, { ok: true, callId });
  }

  // Клиент (RtcSignalingClient) начинает вызов/приём только после этого события —
  // так же, как с production-сервером. Без него звонок «висит» на «Соединение...».
  socket.emit('rtc:ready');
});

// Сообщения чатов с автоудалением старше заданного срока удаляются раз в минуту.
function purgeAutoDeleted() {
  if (!chatAutoDelete.size) return;
  const at = now();
  let removed = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const chatId = typeof message.data?.chat_id === 'string' ? message.data.chat_id : 'general';
    const hours = chatAutoDelete.get(chatId);
    if (hours && message.timestamp < at - hours * 3_600_000) {
      messages.splice(index, 1);
      removed += 1;
    }
  }
  if (removed) {
    log(`auto-delete: removed ${removed} messages`);
    scheduleSave();
  }
}
setInterval(purgeAutoDeleted, 60_000).unref();

loadState();
seedAdmin();
// «Общий» — всегда существующий слой: в него попадают знаки без выбранного слоя.
if (!findLayer(DEFAULT_MARK_LAYER)) {
  tacticalLayers.set('default-layer', {
    id: 'default-layer',
    name: DEFAULT_MARK_LAYER,
    order: -1,
    createdBy: ADMIN_USERNAME,
    createdAt: 0,
  });
}
scheduleSave();

server.listen(PORT, '0.0.0.0', () => {
  log(`LegiON demo server on 0.0.0.0:${PORT}`);
  log('demo login: POST /api/auth/dev {username, passwordHash}');
  log(`admin: ${ADMIN_USERNAME} / ${process.env.ADMIN_PASSWORD ? '(from ADMIN_PASSWORD)' : '123456 (default)'}`);
  log(`state file: ${STATE_FILE || 'disabled'}`);
  log(`TURN: ${TURN_URLS.length ? TURN_URLS.join(',') : 'not configured (только STUN)'}`);
});

function shutdown(signal) {
  log(`shutting down (${signal})`);
  saveState();
  io.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

module.exports = { app, server, users, devices, messages, calls, saveState, loadState, io };
