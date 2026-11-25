const crypto = require('node:crypto');
const http = require('node:http');
const cors = require('cors');
const express = require('express');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const { Pool } = require('pg');
const { createClient } = require('redis');
const { createAdapter } = require('@socket.io/redis-adapter');
const { Server } = require('socket.io');
const { applicationDefault, getApps, initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getMessaging } = require('firebase-admin/messaging');

const PORT = Number(process.env.PORT || 3000);
const MAX_SDP_LENGTH = 256000;
const MAX_CALL_CANDIDATE_LENGTH = 16000;
const MAX_MESSAGE_LENGTH = 12 * 1024 * 1024;
const CALL_TIMEOUT_MS = Number(process.env.RTC_CALL_TIMEOUT_MS || 60000);
const TURN_TTL_SECONDS = Number(process.env.TURN_CREDENTIAL_TTL_SECONDS || 3600);
const allowedOrigins = (process.env.CORS_ORIGINS || '').split(',').map((value) => value.trim()).filter(Boolean);
const stunUrls = (process.env.STUN_URLS || 'stun:stun.l.google.com:19302').split(',').map((value) => value.trim()).filter(Boolean);
const turnUrls = (process.env.TURN_URLS || '').split(',').map((value) => value.trim()).filter(Boolean);
const turnSharedSecret = process.env.TURN_SHARED_SECRET;
const projectId = process.env.FIREBASE_PROJECT_ID;
const registrationCodeSecret = process.env.REGISTRATION_CODE_SECRET;
const messageRetentionDays = Number(process.env.MESSAGE_RETENTION_DAYS || 30);

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error('PORT must be between 1 and 65535');
if (!Number.isSafeInteger(CALL_TIMEOUT_MS) || CALL_TIMEOUT_MS < 1000) throw new Error('RTC_CALL_TIMEOUT_MS must be at least 1000');
if (!Number.isSafeInteger(TURN_TTL_SECONDS) || TURN_TTL_SECONDS < 60) throw new Error('TURN_CREDENTIAL_TTL_SECONDS must be at least 60');
if (Boolean(turnUrls.length) !== Boolean(turnSharedSecret)) throw new Error('Set TURN_URLS and TURN_SHARED_SECRET together');

// Firebase инициализируется лениво: при импорте модуля (тесты, проверка синтаксиса)
// учётные данные не нужны, а ошибка конфигурации всплывает при первом обращении.
let firebaseAppInstance = null;
function firebaseApp() {
    if (!firebaseAppInstance) {
        firebaseAppInstance = getApps()[0] || initializeApp({
            credential: applicationDefault(),
            ...(projectId ? { projectId } : {})
        });
    }
    return firebaseAppInstance;
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const redisPub = createClient({ url: process.env.REDIS_URL });
const redisSub = redisPub.duplicate();
const redisRateLimitStore = {
    windowMs: 60_000,
    init(options) {
        this.windowMs = options.windowMs;
    },
    async increment(key) {
        const [totalHits, timeToLive] = await redisPub.eval(
            "local hits = redis.call('INCR', KEYS[1]); if hits == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]); end; return {hits, redis.call('PTTL', KEYS[1])}",
            { keys: [`http:rate:${key}`], arguments: [String(this.windowMs)] }
        );
        return {
            totalHits: Number(totalHits),
            resetTime: new Date(Date.now() + Math.max(Number(timeToLive), 0))
        };
    },
    async decrement(key) {
        const redisKey = `http:rate:${key}`;
        if (await redisPub.decr(redisKey) <= 0) await redisPub.del(redisKey);
    },
    async resetKey(key) {
        await redisPub.del(`http:rate:${key}`);
    }
};
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: allowedOrigins.length ? allowedOrigins : false },
    maxHttpBufferSize: 512 * 1024
});

app.disable('x-powered-by');
// За обратным прокси (nginx/Caddy/Traefik) без этого все клиенты выглядят как один
// IP и делят один лимит запросов. Значение задаётся явно: TRUST_PROXY=1 (число хопов)
// или TRUST_PROXY=loopback,linklocal,uniquelocal. По умолчанию выключено, чтобы
// нельзя было подделать X-Forwarded-For при прямом доступе.
const trustProxy = process.env.TRUST_PROXY;
if (trustProxy) {
    app.set('trust proxy', /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy);
}
// ---------------------------------------------------------------------------
// Структурное логирование
// ---------------------------------------------------------------------------

function logEvent(level, event, fields = {}) {
    const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields });
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
}

// Каждому запросу — идентификатор: либо от прокси, либо свой. Он попадает в ответ,
// в лог запроса и в лог ошибки, поэтому по одному id видно всю цепочку.
app.use((req, res, next) => {
    const incoming = req.get('x-request-id');
    req.id = incoming && /^[A-Za-z0-9._-]{1,64}$/.test(incoming) ? incoming : crypto.randomUUID();
    res.set('x-request-id', req.id);
    const startedAt = process.hrtime.bigint();
    res.on('finish', () => {
        logEvent('info', 'http_request', {
            requestId: req.id,
            method: req.method,
            path: req.path,
            status: res.statusCode,
            durationMs: Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6 * 100) / 100,
        });
    });
    next();
});

app.use(helmet());
app.use(cors({
    origin(origin, callback) {
        if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
        return callback(new Error('Origin is not allowed'));
    }
}));
app.use(express.json({ limit: '16mb', strict: true }));

// Проверки живости регистрируются ДО ограничителя частоты: оркестратор и прокси
// не должны получать 429, а при недоступном Redis health-check обязан отвечать
// честным 503, а не 500 из middleware.
app.get('/health/live', (req, res) => res.json({ status: 'ok' }));

app.get('/health/ready', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        await redisPub.ping();
        return res.json({ status: 'ready' });
    } catch (error) {
        logEvent('error', 'readiness_failed', { requestId: req.id, message: error.message });
        return res.status(503).json({ status: 'not_ready' });
    }
});

app.use(rateLimit({
    windowMs: 60_000,
    limit: 120,
    standardHeaders: true,
    legacyHeaders: false,
    store: redisRateLimitStore
}));

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toFcmData(data) {
    if (!isRecord(data)) return {};
    return Object.fromEntries(
        Object.entries(data)
            .filter(([, value]) => value !== null && value !== undefined)
            .map(([key, value]) => [key, String(value)])
    );
}

function containsSensitiveField(value) {
    if (!isRecord(value) && !Array.isArray(value)) return false;
    return Object.entries(value).some(([key, child]) => (
        /^(password|passwd|secret|access_?token|refresh_?token|registration_?code)$/i.test(key) ||
        containsSensitiveField(child)
    ));
}

function getBearerToken(header) {
    const match = typeof header === 'string' && /^Bearer ([^\s]+)$/.exec(header);
    return match?.[1];
}

async function verifyFirebaseToken(req, res, next) {
    const token = getBearerToken(req.get('authorization'));
    if (!token) return res.status(401).json({ error: 'Authentication required' });
    try {
        req.user = await getAuth(firebaseApp()).verifyIdToken(token, true);
        return next();
    } catch (error) {
        logEvent('warn', 'firebase_token_invalid', { reason: error.code || error.message });
        return res.status(401).json({ error: 'Invalid or expired authentication token' });
    }
}

function authenticate(req, res, next) {
    return verifyFirebaseToken(req, res, () => {
        if (req.user.legionAccess !== true) return res.status(403).json({ error: 'Account is not enabled for this service' });
        return next();
    });
}

async function firebaseUsername(user) {
    const claimed = user.legionUsername || user.name;
    if (typeof claimed === 'string' && /^[a-zA-Z0-9._-]{1,64}$/.test(claimed.trim())) {
        return claimed.trim().toLowerCase();
    }
    const record = await getAuth(firebaseApp()).getUser(user.uid);
    const displayName = record.displayName;
    return typeof displayName === 'string' && /^[a-zA-Z0-9._-]{1,64}$/.test(displayName.trim())
        ? displayName.trim().toLowerCase()
        : null;
}

app.get('/api/users/deleted', authenticate, async (req, res) => {
    const result = await pool.query('SELECT username FROM deleted_users ORDER BY username');
    return res.json(result.rows.map((row) => row.username));
});

app.get('/api/admin/users', authenticate, async (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Administrator access required' });
    const result = await pool.query(
        `SELECT DISTINCT d.username
         FROM devices d
         WHERE d.username IS NOT NULL
           AND NOT EXISTS (
               SELECT 1 FROM deleted_users deleted WHERE deleted.username = d.username
           )
         ORDER BY d.username`
    );
    return res.json(result.rows.map((row) => row.username));
});

// Для панели администратора: пользователи со структурированным профилем и статусом.
app.get('/api/admin/users/details', authenticate, async (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Administrator access required' });
    const result = await pool.query(
        `SELECT d.username,
                COALESCE(MAX(NULLIF(p.callsign, '')), MAX(NULLIF(d.callsign, '')), d.username) AS callsign,
                COALESCE(MAX(p.position), '') AS position,
                COALESCE(MAX(p.unit), '') AS unit,
                false AS admin,
                BOOL_OR(d.last_seen >= now() - INTERVAL '2 minutes'
                        OR l.updated_at >= now() - INTERVAL '10 minutes') AS "isOnline",
                GREATEST(MAX(d.last_seen), COALESCE(MAX(l.updated_at), d.last_seen)) AS "lastSeen",
                COUNT(*)::int AS devices
         FROM devices d
         LEFT JOIN user_profiles p ON p.username = d.username
         WHERE d.username IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM deleted_users deleted WHERE deleted.username = d.username)
         GROUP BY d.username
         ORDER BY COALESCE(MAX(p.unit), '') = '', MAX(p.unit), callsign`
    );
    return res.json(result.rows);
});

app.get('/api/users', authenticate, async (req, res) => {
    const result = await pool.query(
        `SELECT d.username,
                COALESCE(MAX(NULLIF(p.callsign, '')), MAX(NULLIF(d.callsign, '')), d.username) AS callsign,
                COALESCE(MAX(p.position), '') AS position,
                COALESCE(MAX(p.unit), '') AS unit,
                BOOL_OR(d.last_seen >= now() - INTERVAL '2 minutes'
                        OR l.updated_at >= now() - INTERVAL '10 minutes') AS "isOnline",
                MAX(d.last_seen) AS "lastSeen"
         FROM devices d
         LEFT JOIN user_profiles p ON p.username = d.username
         LEFT JOIN user_locations l ON l.username = d.username
         WHERE d.username IS NOT NULL
           AND NOT EXISTS (
               SELECT 1 FROM deleted_users deleted WHERE deleted.username = d.username
           )
         GROUP BY d.username
         ORDER BY callsign, d.username`
    );
    return res.json(result.rows);
});

app.get('/api/chats', authenticate, async (req, res) => {
    const username = await firebaseUsername(req.user);
    if (!username) return res.status(403).json({ error: 'Account username is not configured' });
    const result = await pool.query(
        `SELECT c.chat_id AS id, c.name, c.created_by AS "createdBy",
                array_agg(m.username ORDER BY m.username) AS members,
                COALESCE(MAX(s.auto_delete_hours), 0) AS "autoDeleteHours"
         FROM chats c
         JOIN chat_members m USING (chat_id)
         LEFT JOIN chat_settings s USING (chat_id)
         WHERE EXISTS (
             SELECT 1 FROM chat_members mine
             WHERE mine.chat_id = c.chat_id AND mine.username = $1
         )
         GROUP BY c.chat_id
         ORDER BY c.created_at`,
        [username]
    );
    return res.json(result.rows);
});

app.post('/api/chats', authenticate, requireRecordBody, async (req, res) => {
    const username = await firebaseUsername(req.user);
    const { id, name, members } = req.body;
    if (!username || typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id) ||
        typeof name !== 'string' || !name.trim() || name.trim().length > 80 ||
        !Array.isArray(members) || members.length < 2 || members.length > 100 ||
        members.some((member) => typeof member !== 'string' || !/^[a-zA-Z0-9._-]{1,64}$/.test(member))) {
        return res.status(400).json({ error: 'Invalid chat details' });
    }
    const normalizedMembers = [...new Set(members.map((member) => member.trim().toLowerCase()))];
    if (!normalizedMembers.includes(username)) return res.status(403).json({ error: 'Creator must be a chat member' });
    const deleted = await pool.query(
        'SELECT username FROM deleted_users WHERE username = ANY($1::text[]) LIMIT 1',
        [normalizedMembers]
    );
    if (deleted.rowCount) return res.status(409).json({ error: 'A deleted user cannot be added to a chat' });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const inserted = await client.query(
            `INSERT INTO chats (chat_id, name, created_by)
             VALUES ($1, $2, $3)
             ON CONFLICT (chat_id) DO NOTHING
             RETURNING chat_id`,
            [id, name.trim(), username]
        );
        const existing = await client.query('SELECT created_by FROM chats WHERE chat_id = $1 FOR UPDATE', [id]);
        if (!existing.rowCount || existing.rows[0].created_by !== username) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'Chat ID is already in use' });
        }
        if (!inserted.rowCount) {
            await client.query('UPDATE chats SET name = $2 WHERE chat_id = $1', [id, name.trim()]);
            await client.query('DELETE FROM chat_members WHERE chat_id = $1', [id]);
        }
        for (const member of normalizedMembers) {
            await client.query('INSERT INTO chat_members (chat_id, username) VALUES ($1, $2)', [id, member]);
        }
        await client.query('COMMIT');
        return res.json({ id, name: name.trim(), createdBy: username, members: normalizedMembers });
    } catch (error) {
        await client.query('ROLLBACK');
        logEvent('error', 'chat_create_failed', { requestId: req.id, message: error.message });
        return res.status(500).json({ error: 'Chat could not be created' });
    } finally {
        client.release();
    }
});

const AUTO_DELETE_HOURS = [0, 1, 5, 12, 24, 48];

// Автоудаление: настройки всех доступных чатов, включая общий — {chatId: часы}.
app.get('/api/chats/settings', authenticate, async (req, res) => {
    const username = await firebaseUsername(req.user);
    if (!username) return res.status(403).json({ error: 'Account username is not configured' });
    const result = await pool.query(
        `SELECT chat_id, auto_delete_hours FROM chat_settings
         WHERE chat_id = 'general'
            OR chat_id IN (SELECT chat_id FROM chat_members WHERE username = $1)`,
        [username]
    );
    const chats = await pool.query('SELECT chat_id FROM chat_members WHERE username = $1', [username]);
    const settings = { general: 0 };
    for (const row of chats.rows) settings[row.chat_id] = 0;
    for (const row of result.rows) settings[row.chat_id] = row.auto_delete_hours;
    return res.json(settings);
});

// Меняет создатель группового чата; общий чат — администратор.
app.put('/api/chats/:id/auto-delete', authenticate, async (req, res) => {
    const username = await firebaseUsername(req.user);
    if (!username) return res.status(403).json({ error: 'Account username is not configured' });
    const chatId = req.params.id;
    let allowed = false;
    if (chatId === 'general') {
        allowed = req.user.admin === true;
    } else {
        const owned = await pool.query('SELECT 1 FROM chats WHERE chat_id = $1 AND created_by = $2', [chatId, username]);
        allowed = owned.rowCount > 0;
    }
    if (!allowed) return res.status(404).json({ error: 'Chat not found or not managed by this account' });
    const hours = Number(isRecord(req.body) ? req.body.hours : NaN);
    if (!AUTO_DELETE_HOURS.includes(hours)) return res.status(400).json({ error: 'hours must be one of 0, 1, 5, 12, 24, 48' });
    await pool.query(
        `INSERT INTO chat_settings (chat_id, auto_delete_hours) VALUES ($1, $2)
         ON CONFLICT (chat_id) DO UPDATE SET auto_delete_hours = EXCLUDED.auto_delete_hours`,
        [chatId, hours]
    );
    purgeAutoDeleted().catch((error) => logEvent('error', 'auto_delete_failed', { message: error.message }));
    return res.json({ id: chatId, autoDeleteHours: hours });
});

async function purgeAutoDeleted() {
    const result = await pool.query(
        `DELETE FROM messages m USING chat_settings s
         WHERE s.auto_delete_hours > 0
           AND COALESCE(m.data->>'chat_id', 'general') = s.chat_id
           AND m.created_at < now() - s.auto_delete_hours * interval '1 hour'`
    );
    if (result.rowCount) logEvent('info', 'auto_delete', { messagesDeleted: result.rowCount });
}

app.patch('/api/chats/:id', authenticate, async (req, res) => {
    const username = await firebaseUsername(req.user);
    if (!username) return res.status(403).json({ error: 'Account username is not configured' });
    const name = isRecord(req.body) ? req.body.name : undefined;
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 80) {
        return res.status(400).json({ error: 'Invalid chat name' });
    }
    // Переименовать может создатель или администратор (как в demo-сервере).
    const result = await pool.query(
        `UPDATE chats SET name = $3 WHERE chat_id = $1 AND (created_by = $2 OR $4::boolean)
         RETURNING chat_id AS id, name, created_by AS "createdBy"`,
        [req.params.id, username, name.trim(), req.user.admin === true]
    );
    if (!result.rowCount) return res.status(404).json({ error: 'Chat not found or not owned by this account' });
    return res.json(result.rows[0]);
});

/**
 * Состав группового чата: создатель или администратор присылает список участников
 * целиком; сервер сам вычисляет добавленных и удалённых и рассылает event chat:changed.
 * Создателя из чата удалить нельзя.
 */
app.put('/api/chats/:id/members', authenticate, requireRecordBody, async (req, res) => {
    const username = await firebaseUsername(req.user);
    if (!username) return res.status(403).json({ error: 'Account username is not configured' });
    if (req.params.id === 'general') {
        return res.status(400).json({ error: 'Members of the general chat are all unit members' });
    }
    const requested = isRecord(req.body) ? req.body.members : null;
    if (!Array.isArray(requested) || requested.length === 0 || requested.length > 100 ||
        requested.some((member) => typeof member !== 'string' || !/^[a-zA-Z0-9._-]{1,64}$/.test(member))) {
        return res.status(400).json({ error: 'members must be an array of 1..100 usernames' });
    }
    const next = [...new Set(requested.map((member) => member.trim().toLowerCase()))];
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const chat = await client.query(
            'SELECT created_by FROM chats WHERE chat_id = $1 AND (created_by = $2 OR $3::boolean) FOR UPDATE',
            [req.params.id, username, req.user.admin === true]
        );
        if (!chat.rowCount) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Chat not found or not owned by this account' });
        }
        const createdBy = chat.rows[0].created_by;
        if (!next.includes(createdBy)) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'The chat creator must stay a member' });
        }
        const deleted = await client.query(
            'SELECT username FROM deleted_users WHERE username = ANY($1::text[]) LIMIT 1', [next]
        );
        if (deleted.rowCount) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'A deleted user cannot be added to a chat' });
        }
        const current = await client.query('SELECT username FROM chat_members WHERE chat_id = $1', [req.params.id]);
        const before = current.rows.map((row) => row.username);
        const added = next.filter((member) => !before.includes(member));
        const removed = before.filter((member) => !next.includes(member));
        for (const member of added) {
            await client.query('INSERT INTO chat_members (chat_id, username) VALUES ($1, $2) ON CONFLICT DO NOTHING',
                [req.params.id, member]);
        }
        for (const member of removed) {
            await client.query('DELETE FROM chat_members WHERE chat_id = $1 AND username = $2', [req.params.id, member]);
        }
        await client.query('COMMIT');
        io.emit('chat:changed', { chatId: req.params.id, added, removed });
        logEvent('info', 'chat_members_updated', { chatId: req.params.id, added: added.length, removed: removed.length });
        return res.json({ id: req.params.id, createdBy, members: next, added, removed });
    } catch (error) {
        await client.query('ROLLBACK');
        logEvent('error', 'chat_members_failed', { requestId: req.id, message: error.message });
        return res.status(500).json({ error: 'Chat members could not be updated' });
    } finally {
        client.release();
    }
});

async function canReadChat(chatId, username) {
    if (chatId === 'general') return true;
    const member = await pool.query('SELECT 1 FROM chat_members WHERE chat_id = $1 AND username = $2', [chatId, username]);
    return member.rowCount > 0;
}

app.post('/api/chats/:id/read', authenticate, async (req, res) => {
    const username = await firebaseUsername(req.user);
    if (!username || !await canReadChat(req.params.id, username)) return res.status(404).json({ error: 'Chat not found' });
    const timestamp = Number(isRecord(req.body) ? req.body.timestamp : NaN);
    if (!Number.isSafeInteger(timestamp) || timestamp <= 0 || timestamp > Date.now() + 60_000) {
        return res.status(400).json({ error: 'Invalid timestamp' });
    }
    await pool.query(
        `INSERT INTO chat_reads (chat_id, username, read_at) VALUES ($1, $2, $3)
         ON CONFLICT (chat_id, username) DO UPDATE SET read_at = GREATEST(chat_reads.read_at, EXCLUDED.read_at)`,
        [req.params.id, username, timestamp]
    );
    return res.json({ status: 'ok' });
});

app.get('/api/chats/:id/reads', authenticate, async (req, res) => {
    const username = await firebaseUsername(req.user);
    if (!username || !await canReadChat(req.params.id, username)) return res.status(404).json({ error: 'Chat not found' });
    const result = await pool.query('SELECT username, read_at FROM chat_reads WHERE chat_id = $1', [req.params.id]);
    return res.json(Object.fromEntries(result.rows.map((row) => [row.username, Number(row.read_at)])));
});

app.delete('/api/chats/:id', authenticate, async (req, res) => {
    const username = await firebaseUsername(req.user);
    if (!username) return res.status(403).json({ error: 'Account username is not configured' });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        // Администратор может удалить любой чат; остальные — только свои (созданные ими).
        const chat = await client.query(
            'SELECT chat_id FROM chats WHERE chat_id = $1 AND (created_by = $2 OR $3::boolean) FOR UPDATE',
            [req.params.id, username, req.user.admin === true]
        );
        if (!chat.rowCount) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Chat not found or not owned by this account' });
        }
        await client.query("DELETE FROM messages WHERE data->>'chat_id' = $1", [req.params.id]);
        await client.query('DELETE FROM chats WHERE chat_id = $1', [req.params.id]);
        await client.query('DELETE FROM chat_reads WHERE chat_id = $1', [req.params.id]);
        await client.query('DELETE FROM chat_settings WHERE chat_id = $1', [req.params.id]);
        await client.query('COMMIT');
        io.emit('chat:deleted', { id: req.params.id });
    return res.json({ status: 'deleted', id: req.params.id });
    } catch (error) {
        await client.query('ROLLBACK');
        logEvent('error', 'chat_delete_failed', { requestId: req.id, message: error.message });
        return res.status(500).json({ error: 'Chat could not be deleted' });
    } finally {
        client.release();
    }
});

app.delete('/api/admin/users/:username', authenticate, async (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Administrator access required' });
    const username = String(req.params.username || '').trim().toLowerCase();
    const adminUsername = await firebaseUsername(req.user);
    if (!/^[a-zA-Z0-9._-]{1,64}$/.test(username) || username === 'admin' || username === adminUsername) {
        return res.status(400).json({ error: 'This user cannot be deleted' });
    }

    let targetUser = null;
    try {
        targetUser = await getAuth(firebaseApp()).getUserByEmail(firebaseEmailForUsername(username));
        if (targetUser.customClaims?.admin === true) {
            return res.status(403).json({ error: 'Administrator accounts cannot be deleted here' });
        }
        await getAuth(firebaseApp()).deleteUser(targetUser.uid);
    } catch (error) {
        if (error.code !== 'auth/user-not-found') {
            logEvent('error', 'user_delete_failed', { requestId: req.id, reason: error.code || error.message });
            return res.status(500).json({ error: 'User could not be deleted' });
        }
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        if (targetUser) {
            await client.query('DELETE FROM devices WHERE firebase_uid = $1', [targetUser.uid]);
        }
        await client.query('DELETE FROM devices WHERE username = $1', [username]);
        await client.query('DELETE FROM user_profiles WHERE username = $1', [username]);
        await client.query('DELETE FROM user_locations WHERE username = $1', [username]);
        await client.query('DELETE FROM registration_codes WHERE username = $1', [username]);
        await client.query('DELETE FROM chat_members WHERE username = $1', [username]);
        await client.query("DELETE FROM messages WHERE data->>'username' = $1", [username]);
        await client.query(
            'INSERT INTO deleted_users (username) VALUES ($1) ON CONFLICT (username) DO UPDATE SET deleted_at = now()',
            [username]
        );
        await client.query('COMMIT');
        return res.json({ status: 'deleted', username });
    } catch (error) {
        await client.query('ROLLBACK');
        logEvent('error', 'user_delete_cleanup_failed', { requestId: req.id, message: error.message });
        return res.status(500).json({ error: 'User access was revoked but cleanup failed' });
    } finally {
        client.release();
    }
});

function registrationCodeDigest(username, code) {
    return crypto.createHmac('sha256', registrationCodeSecret)
        .update(`${username.trim().toLowerCase()}:${code.trim().toUpperCase()}`)
        .digest('hex');
}

function firebaseEmailForUsername(username) {
    const digest = crypto.createHash('sha256').update(username.trim().toLowerCase()).digest('hex');
    return `u-${digest}@legion.invalid`;
}

function requireRecordBody(req, res, next) {
    if (!isRecord(req.body)) return res.status(400).json({ error: 'Request body must be a JSON object' });
    return next();
}

async function verifyDevice(uid, phoneId) {
    if (typeof phoneId !== 'string' || phoneId.length < 1 || phoneId.length > 128) return null;
    const result = await pool.query(
        `UPDATE devices SET last_seen = now()
         WHERE phone_id = $1 AND firebase_uid = $2
         RETURNING phone_id, name, last_seen, username, callsign`,
        [phoneId, uid]
    );
    return result.rows[0] || null;
}

async function chatTargetDeviceIds(chatId, username, senderUid, senderPhoneId) {
    if (chatId === 'general') return targetDeviceIds('all', senderUid);
    const result = await pool.query(
        `SELECT d.phone_id
         FROM chat_members m
         JOIN devices d ON d.username = m.username
         WHERE m.chat_id = $1 AND d.phone_id <> $2`,
        [chatId, senderPhoneId]
    );
    const members = await pool.query(
        'SELECT 1 FROM chat_members WHERE chat_id = $1 AND username = $2',
        [chatId, username]
    );
    return members.rowCount ? result.rows.map((row) => row.phone_id) : null;
}

async function targetDeviceIds(to, senderUid) {
    if (typeof to === 'string' && to !== 'all') {
        const result = await pool.query(
            'SELECT phone_id FROM devices WHERE phone_id = $1 AND firebase_uid <> $2',
            [to, senderUid]
        );
        return result.rows.map((row) => row.phone_id);
    }
    const result = await pool.query('SELECT phone_id FROM devices WHERE firebase_uid <> $1', [senderUid]);
    return result.rows.map((row) => row.phone_id);
}

async function sendPush(phoneIds, title, body, data = {}) {
    const uniqueIds = [...new Set(phoneIds)];
    if (uniqueIds.length === 0) return { sent: 0, failed: 0, skipped: true, reason: 'no_targets' };
    const result = await pool.query(
        'SELECT phone_id, fcm_token FROM devices WHERE phone_id = ANY($1::text[]) AND fcm_token IS NOT NULL',
        [uniqueIds]
    );
    const devices = result.rows;
    if (devices.length === 0) return { sent: 0, failed: 0, skipped: true, reason: 'no_registered_fcm_tokens' };

    const fcmData = toFcmData(data);
    const isCall = fcmData.type === 'rtc_call';
    // Сбор о сборе: канал с мелодией будильника (звук задаёт клиент, канал alerts).
    const isAlert = fcmData.type === 'alert';
    // Клиент (LegionMessagingService) по наличию notification-блока понимает, что система
    // покажет уведомление сама при свёрнутом приложении. Телефонам без
    // POST_NOTIFICATIONS (Android 13+, система блокирует) и всем со свёрнутым
    // приложением нужен именно notification-блок — иначе фоновое уведомление не появится.
    const notificationData = isCall ? { ...fcmData, title, body } : fcmData;
    const response = await getMessaging(firebaseApp()).sendEachForMulticast({
        tokens: devices.map(({ fcm_token: token }) => token),
        ...(isCall ? {} : { notification: { title, body } }),
        // app_id/project_id обязательны в data для однозначной инициализации SDK.
        data: { ...notificationData, projectId: projectId || undefined },
        android: {
            priority: 'high',
            ...(isCall ? {
                ttl: 60_000,
            } : { ttl: 24 * 60 * 60 * 1000 }),
            ...(isAlert ? {
                ttl: 10 * 60_000,
                notification: {
                    channelId: 'legion_alerts',
                    sound: 'alarm',
                    priority: 'max',
                    category: 'alarm',
                    visibility: 'public',
                },
            } : {}),
            ...(isCall ? {
                notification: {
                    channelId: 'legion_incoming_calls',
                    sound: 'default',
                    priority: 'max',
                    category: 'call',
                    visibility: 'public',
                },
            } : {}),
        },
        apns: {
            headers: { 'apns-priority': '10' },
            payload: {
                aps: {
                    'content-available': 1,
                    ...(isCall ? { 'interruption-level': 'time-sensitive' } : {}),
                },
            },
        },
        webpush: { headers: { Urgency: 'high' } },
    });

    const invalidTokens = [];
    response.responses.forEach((item, index) => {
        if (item.success) return;
        const code = item.error?.code;
        if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') {
            invalidTokens.push(devices[index].phone_id);
        }
    });
    if (invalidTokens.length) {
        await pool.query('UPDATE devices SET fcm_token = NULL WHERE phone_id = ANY($1::text[])', [invalidTokens]);
    }
    return { sent: response.successCount, failed: response.failureCount };
}

async function sendCallEvent(phoneId, event, payload) {
    const sockets = await io.in(`phone:${phoneId}`).fetchSockets();
    if (!sockets.length) return false;
    io.to(`phone:${phoneId}`).emit(event, payload);
    return true;
}

async function getCall(callId, client) {
    const result = await client.query('SELECT * FROM calls WHERE call_id = $1 FOR UPDATE', [callId]);
    return result.rows[0] || null;
}

async function finishCall(callId, reason, notifyPhoneIds) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const call = await getCall(callId, client);
        if (!call) {
            await client.query('ROLLBACK');
            return false;
        }
        await client.query('DELETE FROM call_participants WHERE call_id = $1', [callId]);
        await client.query('DELETE FROM calls WHERE call_id = $1', [callId]);
        await client.query('COMMIT');
        for (const phoneId of notifyPhoneIds) {
            await sendCallEvent(phoneId, 'rtc:ended', { callId, reason });
        }
        return true;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

async function rateSocketEvent(phoneId) {
    const key = `rtc:rate:${phoneId}`;
    const count = await redisPub.incr(key);
    if (count === 1) await redisPub.expire(key, 10);
    return count <= 80;
}

app.post('/api/registration-codes', authenticate, requireRecordBody, async (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Administrator access required' });
    const { username, code } = req.body;
    if (typeof username !== 'string' || !/^[a-zA-Z0-9._-]{1,64}$/.test(username) ||
        typeof code !== 'string' || !/^[a-zA-Z0-9-]{6,32}$/.test(code)) {
        return res.status(400).json({ error: 'Invalid username or registration code' });
    }
    const deleted = await pool.query('SELECT 1 FROM deleted_users WHERE username = $1', [username.toLowerCase()]);
    if (deleted.rowCount) return res.status(410).json({ error: 'This username has been permanently deleted' });
    await pool.query(
        `INSERT INTO registration_codes (username, code_digest, created_by, expires_at)
         VALUES ($1, $2, $3, now() + interval '24 hours')
         ON CONFLICT (username) DO UPDATE SET
           code_digest = EXCLUDED.code_digest,
           created_by = EXCLUDED.created_by,
           expires_at = EXCLUDED.expires_at`,
        [username.toLowerCase(), registrationCodeDigest(username, code), req.user.uid]
    );
    return res.json({ status: 'ok', expiresInSeconds: 86400 });
});

app.post('/api/registration-codes/verify', verifyFirebaseToken, requireRecordBody, async (req, res) => {
    const { username, code } = req.body;
    if (typeof username !== 'string' || !/^[a-zA-Z0-9._-]{1,64}$/.test(username) ||
        typeof code !== 'string' || !/^[a-zA-Z0-9-]{6,32}$/.test(code)) {
        return res.status(400).json({ error: 'Invalid username or registration code' });
    }
    const normalizedUsername = username.toLowerCase();
    if (req.user.email !== firebaseEmailForUsername(normalizedUsername)) {
        return res.status(403).json({ error: 'Firebase identity does not match username' });
    }
    if (req.user.legionAccess === true && req.user.legionUsername === normalizedUsername) {
        return res.json({ status: 'ok', alreadyVerified: true });
    }
    const digest = registrationCodeDigest(normalizedUsername, code);
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await client.query(
            'DELETE FROM registration_codes WHERE username = $1 AND code_digest = $2 AND expires_at > now() RETURNING username',
            [normalizedUsername, digest]
        );
        if (!result.rowCount) {
            await client.query('ROLLBACK');
            return res.status(403).json({ error: 'Invalid or expired registration code' });
        }
        const user = await getAuth(firebaseApp()).getUser(req.user.uid);
        await getAuth(firebaseApp()).setCustomUserClaims(req.user.uid, {
            ...user.customClaims,
            legionAccess: true,
            legionUsername: normalizedUsername
        });
        await client.query('COMMIT');
        return res.json({ status: 'ok' });
    } catch (error) {
        await client.query('ROLLBACK');
        logEvent('error', 'registration_verify_failed', { requestId: req.id, reason: error.code || error.message });
        return res.status(500).json({ error: 'Registration verification failed' });
    } finally {
        client.release();
    }
});

app.post('/api/register', authenticate, requireRecordBody, async (req, res) => {
    const { phoneId, name, fcmToken, callsign, position, unit } = req.body;
    for (const [field, value] of [['position', position], ['unit', unit]]) {
        if (value !== undefined && value !== null && (typeof value !== 'string' || value.length > 120)) {
            return res.status(400).json({ error: `${field} must be a string of at most 120 characters` });
        }
    }
    if (typeof phoneId !== 'string' || phoneId.trim().length < 1 || phoneId.trim().length > 128) {
        return res.status(400).json({ error: 'phoneId must be a non-empty string of at most 128 characters' });
    }
    if (name !== undefined && (typeof name !== 'string' || name.length > 120)) {
        return res.status(400).json({ error: 'name must be a string of at most 120 characters' });
    }
    if (fcmToken !== undefined && (typeof fcmToken !== 'string' || fcmToken.length < 1 || fcmToken.length > 4096)) {
        return res.status(400).json({ error: 'fcmToken must be a non-empty string of at most 4096 characters' });
    }
    if (callsign !== undefined && (typeof callsign !== 'string' || callsign.length > 120)) {
        return res.status(400).json({ error: 'callsign must be a string of at most 120 characters' });
    }

    const id = phoneId.trim();
    const username = await firebaseUsername(req.user);
    if (!username) return res.status(403).json({ error: 'Account username is not configured' });
    try {
        const result = await pool.query(
            `INSERT INTO devices (phone_id, firebase_uid, username, callsign, name, fcm_token, last_seen)
             VALUES ($1, $2, $3, $4, $5, $6, now())
             ON CONFLICT (phone_id) DO UPDATE SET
               username = EXCLUDED.username,
               callsign = COALESCE(NULLIF(EXCLUDED.callsign, ''), devices.callsign),
               name = EXCLUDED.name,
               fcm_token = COALESCE(EXCLUDED.fcm_token, devices.fcm_token),
               last_seen = now()
             WHERE devices.firebase_uid = EXCLUDED.firebase_uid
             RETURNING phone_id`,
            [id, req.user.uid, username, callsign?.trim() || null, name?.trim() || 'Android device', fcmToken?.trim() || null]
        );
        if (!result.rowCount) return res.status(409).json({ error: 'phoneId is registered to another account' });
        // Профиль — у пользователя; пустые поля не затирают сохранённые.
        await pool.query(
            `INSERT INTO user_profiles (username, callsign, position, unit) VALUES ($1, $2, $3, $4)
             ON CONFLICT (username) DO UPDATE SET
               callsign = COALESCE(EXCLUDED.callsign, user_profiles.callsign),
               position = COALESCE(EXCLUDED.position, user_profiles.position),
               unit = COALESCE(EXCLUDED.unit, user_profiles.unit),
               updated_at = now()`,
            [username, callsign?.trim() || null, position?.trim() || null, unit?.trim() || null]
        );
        return res.json({ status: 'ok', pushEnabled: Boolean(fcmToken) });
    } catch (error) {
        logEvent('error', 'device_registration_failed', { requestId: req.id, message: error.message });
        return res.status(500).json({ error: 'Device registration failed' });
    }
});

app.post('/api/send', authenticate, requireRecordBody, async (req, res) => {
    const { from, to, text, data } = req.body;
    const phoneId = req.get('x-device-id');
    if (!await verifyDevice(req.user.uid, phoneId)) return res.status(403).json({ error: 'Device is not registered to this account' });
    if (typeof text !== 'string' || text.trim().length === 0 || text.length > MAX_MESSAGE_LENGTH) {
        return res.status(400).json({ error: `text must contain 1 to ${MAX_MESSAGE_LENGTH} characters` });
    }
    if (!isRecord(data) || Buffer.byteLength(JSON.stringify(data)) > 8_000) {
        return res.status(400).json({ error: 'data must be a JSON object no larger than 8 KB' });
    }
    if (['user_account', 'registration_code', 'webrtc_signal'].includes(data.type)) {
        return res.status(400).json({ error: 'Sensitive control data cannot be sent as chat messages' });
    }
    let recipients;
    // Любое сообщение, привязанное к чату (текст, файл, аудио, изображение), уходит участникам
    // этого чата; адресное сообщение без chat_id — по полю to.
    if (data.type === 'text' || typeof data.chat_id === 'string') {
        const chatId = typeof data.chat_id === 'string' ? data.chat_id : 'general';
        const username = await firebaseUsername(req.user);
        recipients = username ? await chatTargetDeviceIds(chatId, username, req.user.uid, phoneId) : null;
        if (recipients === null) return res.status(403).json({ error: 'Not a member of this chat' });
    } else {
        recipients = await targetDeviceIds(to, req.user.uid);
    }
    if (typeof to === 'string' && to !== 'all' && recipients.length === 0) {
        return res.status(404).json({ error: 'Target device not found' });
    }
    if (containsSensitiveField(data)) return res.status(400).json({ error: 'Sensitive fields cannot be sent in messages' });
    const senderName = typeof req.user.name === 'string' && req.user.name.trim()
        ? req.user.name.trim().slice(0, 120)
        : req.user.uid;
    const client = await pool.connect();
    let sentAt;
    try {
        await client.query('BEGIN');
        // now() в транзакции одинаков для всех вставок — это и есть время сообщения.
        sentAt = Number((await client.query(
            'SELECT (extract(epoch FROM now()) * 1000)::bigint AS ts'
        )).rows[0].ts);
        for (const target of recipients) {
            await client.query(
                `INSERT INTO messages (sender_uid, sender_phone_id, sender_name, recipient_phone_id, text, data)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [req.user.uid, phoneId, senderName, target, text.trim(), data]
            );
        }
        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        logEvent('error', 'message_persist_failed', { requestId: req.id, message: error.message });
        return res.status(500).json({ error: 'Message could not be stored' });
    } finally {
        client.release();
    }
    try {
        const pushBody = data.has_attachment === true ? 'Вложение' : 'Новое сообщение';
        const delivery = await sendPush(recipients, senderName, pushBody, { ...toFcmData(data), sender: senderName });
        return res.json({ status: 'ok', timestamp: sentAt, delivery });
    } catch (error) {
        logEvent('error', 'push_failed', { requestId: req.id, reason: error.code || error.message });
        return res.json({ status: 'stored', timestamp: sentAt, delivery: { sent: 0, failed: recipients.length, notificationError: true } });
    }
});

app.post('/api/push', authenticate, requireRecordBody, async (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Administrator access required' });
    const { to, title, body, data = {} } = req.body;
    if (typeof title !== 'string' || !title.trim() || title.length > 120 ||
        typeof body !== 'string' || !body.trim() || body.length > 1000 || !isRecord(data)) {
        return res.status(400).json({ error: 'Invalid notification payload' });
    }
    const targets = await targetDeviceIds(to, req.user.uid);
    if (to && to !== 'all' && targets.length === 0) return res.status(404).json({ error: 'Target device not found' });
    try {
        const delivery = await sendPush(targets, title.trim(), body.trim(), data);
        if (delivery.skipped) return res.status(404).json({ error: 'No registered FCM tokens', delivery });
        if (delivery.failed) return res.status(502).json({ error: 'Some notifications failed', delivery });
        return res.json({ status: 'ok', delivery });
    } catch (error) {
        logEvent('error', 'push_failed', { requestId: req.id, reason: error.code || error.message });
        return res.status(502).json({ error: 'Push delivery failed' });
    }
});

app.post('/api/alerts/:id/ack', authenticate, async (req, res) => {
    const alertId = Number(req.params.id);
    if (!Number.isFinite(alertId)) return res.status(400).json({ error: 'Invalid alert id' });
    const username = await firebaseUsername(req.user);
    if (!username) return res.status(403).json({ error: 'Account is not enabled for this service' });
    await pool.query(
        `INSERT INTO alert_responses (alert_id, username, status)
         VALUES ($1, $2, 'confirmed')
         ON CONFLICT (alert_id, username) DO UPDATE SET status='confirmed', responded_at=now()`,
        [alertId, username]
    );
    io.to('admin').emit('alert:ack', { alertId, username });
    return res.json({ status: 'ok' });
});

app.get('/api/alerts/:id/responses', authenticate, async (req, res) => {
    const alertId = Number(req.params.id);
    if (!Number.isFinite(alertId)) return res.status(400).json({ error: 'Invalid alert id' });
    const result = await pool.query(
        `SELECT username, status, responded_at FROM alert_responses WHERE alert_id = $1 ORDER BY responded_at`,
        [alertId]
    );
    return res.json(result.rows);
});

// Входящие сообщения устройства. Раньше у маршрута не было заголовка app.get(...) —
// файл не проходил `node --check`, и весь сервер не запускался.
app.get('/api/messages', authenticate, async (req, res) => {
    const phoneId = req.get('x-device-id');
    if (!await verifyDevice(req.user.uid, phoneId)) return res.status(403).json({ error: 'Device is not registered to this account' });
    // ?after=<id> — только новые сообщения (клиент опрашивает каждые несколько секунд).
    const after = /^\d{1,18}$/.test(String(req.query.after || '')) ? req.query.after : '0';
    const result = await pool.query(
        `SELECT id::text AS id, sender_name AS "from", recipient_phone_id AS "to", text, data,
                (extract(epoch FROM created_at) * 1000)::bigint AS "timestamp"
         FROM messages WHERE recipient_phone_id = $1 AND id > $2::bigint
         ORDER BY id ASC LIMIT 500`,
        [phoneId, after]
    );
    // По возрастанию от курсора: клиент продвигает курсор и дочитывает пропущенное при следующем опросе,
    // поэтому даже при очень длинной истории ни одно сообщение (в том числе файл) не теряется.
    return res.json(result.rows);
});

app.get('/api/phones', authenticate, async (req, res) => {
    const result = await pool.query(
        `SELECT d.phone_id AS id, d.name, d.username, d.callsign, d.last_seen AS "lastSeen",
                (d.last_seen >= now() - INTERVAL '2 minutes'
                 OR l.updated_at >= now() - INTERVAL '10 minutes') AS "isOnline"
         FROM devices d
         LEFT JOIN user_locations l ON l.username = d.username
         WHERE d.firebase_uid <> $1 AND d.fcm_token IS NOT NULL
           AND NOT EXISTS (
               SELECT 1 FROM deleted_users deleted WHERE deleted.username = d.username
           )
         ORDER BY d.last_seen DESC, d.name`,
        [req.user.uid]
    );
    return res.json(result.rows);
});

app.get('/api/phone/:id', authenticate, async (req, res) => {
    const result = await pool.query(
        `SELECT phone_id AS id, name, username, callsign, last_seen AS "lastSeen",
                last_seen >= now() - INTERVAL '2 minutes' AS "isOnline"
         FROM devices
         WHERE phone_id = $1 AND firebase_uid <> $2
           AND NOT EXISTS (
               SELECT 1 FROM deleted_users deleted WHERE deleted.username = devices.username
           )`,
        [req.params.id, req.user.uid]
    );
    if (!result.rowCount) return res.status(404).json({ error: 'Phone not found' });
    return res.json(result.rows[0]);
});

// ---------------------------------------------------------------------------
// Последние позиции пользователей: хранятся на сервере, обновления — сокетом location:update
// ---------------------------------------------------------------------------

function parseLocation(body) {
    if (!isRecord(body)) return null;
    const { lat, lng, callsign } = body;
    if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    if (callsign !== undefined && callsign !== null && (typeof callsign !== 'string' || callsign.length > 120)) return null;
    return { lat, lng, callsign: typeof callsign === 'string' ? callsign.trim() : null };
}

app.post('/api/location', authenticate, requireRecordBody, async (req, res) => {
    const phoneId = req.get('x-device-id');
    if (!await verifyDevice(req.user.uid, phoneId)) return res.status(403).json({ error: 'Device is not registered to this account' });
    const location = parseLocation(req.body);
    if (!location) return res.status(400).json({ error: 'lat and lng must be valid coordinates' });
    const username = await firebaseUsername(req.user);
    if (!username) return res.status(403).json({ error: 'Account username is not configured' });
    const result = await pool.query(
        `INSERT INTO user_locations (username, callsign, lat, lng, updated_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (username) DO UPDATE SET
           callsign = COALESCE(EXCLUDED.callsign, user_locations.callsign),
           lat = EXCLUDED.lat, lng = EXCLUDED.lng, updated_at = now()
         RETURNING username, callsign, lat, lng, (extract(epoch FROM updated_at) * 1000)::bigint AS "updatedAt"`,
        [username, location.callsign || null, location.lat, location.lng]
    );
    const row = result.rows[0];
    io.emit('location:update', row);
    return res.json(row);
});

app.get('/api/locations', authenticate, async (req, res) => {
    const result = await pool.query(
        `SELECT l.username, COALESCE(NULLIF(l.callsign, ''), p.callsign, l.username) AS callsign,
                l.lat, l.lng, (extract(epoch FROM l.updated_at) * 1000)::bigint AS "updatedAt"
         FROM user_locations l
         LEFT JOIN user_profiles p ON p.username = l.username
         WHERE NOT EXISTS (SELECT 1 FROM deleted_users deleted WHERE deleted.username = l.username)`
    );
    return res.json(result.rows);
});

// ---------------------------------------------------------------------------
// Сборы: подтверждение получения сразу видно администратору (событие alert:ack)
// ---------------------------------------------------------------------------

const ALERT_ID = /^[A-Za-z0-9_-]{1,64}$/;

// Получатель подтверждает сбор. Администратор получает событие alert:ack мгновенно.
app.post('/api/alerts/:id/ack', authenticate, requireRecordBody, async (req, res) => {
    const phoneId = req.get('x-device-id');
    if (!await verifyDevice(req.user.uid, phoneId)) return res.status(403).json({ error: 'Device is not registered to this account' });
    const alertId = String(req.params.id || '');
    if (!ALERT_ID.test(alertId)) return res.status(400).json({ error: 'Invalid alert id' });
    const username = await firebaseUsername(req.user);
    if (!username) return res.status(403).json({ error: 'Account username is not configured' });
    const callsign = typeof req.user.name === 'string' && req.user.name.trim() ? req.user.name.trim().slice(0, 120) : username;
    const result = await pool.query(
        `INSERT INTO alert_acks (alert_id, username, acked_at) VALUES ($1, $2, now())
         ON CONFLICT (alert_id, username) DO UPDATE SET acked_at = now()
         RETURNING alert_id, username, (extract(epoch FROM acked_at) * 1000)::bigint AS "ackedAt"`,
        [alertId, username]
    );
    const ack = { ...result.rows[0], ackedAt: Number(result.rows[0].ackedAt), callsign };
    io.emit('alert:ack', ack);
    return res.json(ack);
});

// Список подтверждений по сбору — для экрана администратора.
app.get('/api/alerts/:id/acks', authenticate, async (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Administrator access required' });
    const alertId = String(req.params.id || '');
    if (!ALERT_ID.test(alertId)) return res.status(400).json({ error: 'Invalid alert id' });
    const result = await pool.query(
        `SELECT a.alert_id, a.username, COALESCE(NULLIF(p.callsign, ''), a.username) AS callsign,
                (extract(epoch FROM a.acked_at) * 1000)::bigint AS "ackedAt"
         FROM alert_acks a LEFT JOIN user_profiles p ON p.username = a.username
         WHERE a.alert_id = $1 ORDER BY a.acked_at`,
        [alertId]
    );
    return res.json(result.rows.map((row) => ({ ...row, ackedAt: Number(row.ackedAt) })));
});

// ---------------------------------------------------------------------------
// Тактические знаки: общие для всех, изменения рассылаются по сокету (marks:changed)
// ---------------------------------------------------------------------------

const MARK_ID = /^[0-9a-f-]{36}$/i;
/**
 * Ключ значка у знака: builtin:<key>, custom:<iconId>, путь картинки из KMZ
 * («styles/Flag.png»), а также AlpineQuest-имена («Summit.png», «Гора») — их клиент
 * присылает при импорте KML/KMZ.
 */
const ICON_KEY = /^[\p{L}\p{N}_.: \\/-]{1,120}$/u;
const ICON_ID = /^[a-z0-9_-]{1,64}$/;
const MAX_ICON_BYTES = 100 * 1024;
const MARK_COLUMNS = `id::text AS id, type, label, lat, lng, icon, layer, created_by AS "createdBy",
    (extract(epoch FROM created_at) * 1000)::bigint AS "createdAt"`;
const DEFAULT_MARK_LAYER = 'Общий';

function parseMark(body) {
    if (!isRecord(body)) return null;
    const { id, type, label, lat, lng, icon, layer } = body;
    if (typeof id !== 'string' || !MARK_ID.test(id)) return null;
    if (typeof type !== 'string' || !type.trim() || type.length > 60) return null;
    if (label !== undefined && label !== null && (typeof label !== 'string' || label.length > 120)) return null;
    if (typeof lat !== 'number' || typeof lng !== 'number' || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    // Раньше шаблон ^[a-z0-9_:-]{1,80}$ отклонял значки AlpineQuest («Summit.png»,
    // «Гора») и custom:<id> — импорт падал на первом же знаке.
    if (icon !== undefined && icon !== null && (typeof icon !== 'string' || !ICON_KEY.test(icon))) return null;
    if (layer !== undefined && layer !== null && (typeof layer !== 'string' || layer.trim().length > 60)) return null;
    const layerName = typeof layer === 'string' && layer.trim() ? layer.trim() : DEFAULT_MARK_LAYER;
    return { id: id.toLowerCase(), type: type.trim(), label: (label || '').trim(), lat, lng, icon: icon || null, layer: layerName };
}

async function insertMarks(marks, username) {
    let added = 0;
    for (const mark of marks) {
        const result = await pool.query(
            `INSERT INTO tactical_marks (id, type, label, lat, lng, icon, layer, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING`,
            [mark.id, mark.type, mark.label, mark.lat, mark.lng, mark.icon, mark.layer, username]
        );
        added += result.rowCount;
    }
    if (added) io.emit('marks:changed', { at: Date.now() });
    return added;
}

app.get('/api/marks', authenticate, async (req, res) => {
    const result = await pool.query(`SELECT ${MARK_COLUMNS} FROM tactical_marks ORDER BY created_at`);
    return res.json(result.rows.map((row) => ({ ...row, createdAt: Number(row.createdAt) })));
});

app.post('/api/marks', authenticate, async (req, res) => {
    const username = await firebaseUsername(req.user);
    const mark = parseMark(req.body);
    if (!username || !mark) return res.status(400).json({ error: 'Invalid mark' });
    await insertMarks([mark], username);
    const result = await pool.query(`SELECT ${MARK_COLUMNS} FROM tactical_marks WHERE id = $1`, [mark.id]);
    return res.json({ ...result.rows[0], createdAt: Number(result.rows[0].createdAt) });
});

app.post('/api/marks/batch', authenticate, async (req, res) => {
    const username = await firebaseUsername(req.user);
    const list = isRecord(req.body) ? req.body.marks : null;
    if (!username || !Array.isArray(list) || list.length === 0 || list.length > 1000) {
        return res.status(400).json({ error: 'marks must be an array of 1..1000 items' });
    }
    const parsed = list.map(parseMark);
    if (parsed.some((mark) => !mark)) return res.status(400).json({ error: 'Invalid mark in batch' });
    return res.json({ added: await insertMarks(parsed, username) });
});

app.delete('/api/marks/:id', authenticate, async (req, res) => {
    const username = await firebaseUsername(req.user);
    if (!MARK_ID.test(String(req.params.id))) return res.status(404).json({ error: 'Mark not found' });
    const mark = await pool.query('SELECT created_by FROM tactical_marks WHERE id = $1', [req.params.id]);
    if (!mark.rowCount) return res.status(404).json({ error: 'Mark not found' });
    if (mark.rows[0].created_by !== username && req.user.admin !== true) {
        return res.status(403).json({ error: 'Only the author or an administrator can delete this mark' });
    }
    await pool.query('DELETE FROM tactical_marks WHERE id = $1', [req.params.id]);
    io.emit('marks:changed', { at: Date.now() });
    return res.json({ status: 'deleted', id: req.params.id });
});

// ---------------------------------------------------------------------------
// Слои тактических знаков: общие для подразделения. Знак ссылается на слой полем layer;
// слой без знаков существует отдельно, поэтому клиенты получают список слоёв с сервера
// (а не выводят его из знаков на карте). Схема — migrations/009_tactical_layers.sql.
// ---------------------------------------------------------------------------

const LAYER_NAME_MAX = 60;
const LAYER_COLUMNS = `id::text AS id, name, "order", created_by AS "createdBy",
    (extract(epoch FROM created_at) * 1000)::bigint AS "createdAt"`;

async function findLayerByName(name) {
    const result = await pool.query(`SELECT ${LAYER_COLUMNS} FROM tactical_layers WHERE lower(name) = lower($1)`, [name]);
    return result.rows[0] || null;
}

async function ensureLayer(name, username) {
    const result = await pool.query(
        `INSERT INTO tactical_layers (name, "order", created_by)
         VALUES ($1, COALESCE((SELECT MAX("order") + 1 FROM tactical_layers), 0), $2)
         ON CONFLICT (name) DO UPDATE SET name = tactical_layers.name
         RETURNING ${LAYER_COLUMNS.replace(/created_at/g, 'tactical_layers.created_at').replace(/id::text/g, 'tactical_layers.id::text')}`,
        [name.trim().slice(0, LAYER_NAME_MAX), username]
    );
    return result.rows[0];
}

app.get('/api/mark-layers', authenticate, async (req, res) => {
    const result = await pool.query(`SELECT ${LAYER_COLUMNS} FROM tactical_layers ORDER BY "order", name`);
    if (!result.rowCount) {
        // Первый запуск: «Общий» создаётся лениво, чтобы не зависеть от прогона миграции с данными.
        await ensureLayer(DEFAULT_MARK_LAYER, null);
        const retry = await pool.query(`SELECT ${LAYER_COLUMNS} FROM tactical_layers ORDER BY "order", name`);
        return res.json(retry.rows.map((row) => ({ ...row, createdAt: Number(row.createdAt) })));
    }
    return res.json(result.rows.map((row) => ({ ...row, createdAt: Number(row.createdAt) })));
});

app.post('/api/mark-layers', authenticate, async (req, res) => {
    const username = await firebaseUsername(req.user);
    const name = isRecord(req.body) ? req.body.name : null;
    if (!username || typeof name !== 'string' || !name.trim() || name.trim().length > LAYER_NAME_MAX) {
        return res.status(400).json({ error: `Layer name must be 1..${LAYER_NAME_MAX} characters` });
    }
    if (await findLayerByName(name)) return res.status(409).json({ error: 'layer_exists' });
    const layer = await ensureLayer(name, username);
    io.emit('marks:changed', { at: Date.now() });
    return res.json({ ...layer, createdAt: Number(layer.createdAt) });
});

app.patch('/api/mark-layers/:id', authenticate, async (req, res) => {
    const username = await firebaseUsername(req.user);
    if (!MARK_ID.test(String(req.params.id))) return res.status(404).json({ error: 'Layer not found' });
    const name = isRecord(req.body) ? req.body.name : null;
    if (typeof name !== 'string' || !name.trim() || name.trim().length > LAYER_NAME_MAX) {
        return res.status(400).json({ error: `Layer name must be 1..${LAYER_NAME_MAX} characters` });
    }
    const existing = await pool.query(`SELECT ${LAYER_COLUMNS} FROM tactical_layers WHERE id = $1`, [req.params.id]);
    if (!existing.rowCount) return res.status(404).json({ error: 'Layer not found' });
    const layer = existing.rows[0];
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('UPDATE tactical_layers SET name = $2 WHERE id = $1', [req.params.id, name.trim()]);
        await client.query('UPDATE tactical_marks SET layer = $2 WHERE lower(layer) = lower($1)', [layer.name, name.trim()]);
        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        if (error.code === '23505') return res.status(409).json({ error: 'layer_exists' });
        throw error;
    } finally {
        client.release();
    }
    io.emit('marks:changed', { at: Date.now() });
    return res.json({ ...layer, name: name.trim() });
});

// Удаление слоя: знаки (withMarks=move по умолчанию) переносятся в «Общий» или удаляются.
app.delete('/api/mark-layers/:id', authenticate, async (req, res) => {
    const username = await firebaseUsername(req.user);
    if (!MARK_ID.test(String(req.params.id))) return res.status(404).json({ error: 'Layer not found' });
    const existing = await pool.query(`SELECT ${LAYER_COLUMNS} FROM tactical_layers WHERE id = $1`, [req.params.id]);
    if (!existing.rowCount) return res.status(404).json({ error: 'Layer not found' });
    const layer = existing.rows[0];
    if (layer.name.toLowerCase() === DEFAULT_MARK_LAYER.toLowerCase()) {
        return res.status(400).json({ error: 'default_layer' });
    }
    if (layer.createdBy !== username && req.user.admin !== true) {
        return res.status(403).json({ error: 'Only the author or an administrator can delete this layer' });
    }
    const withMarks = String(req.query.withMarks || 'move');
    if (!['move', 'delete'].includes(withMarks)) {
        return res.status(400).json({ error: 'withMarks must be move or delete' });
    }
    const defaultLayer = await ensureLayer(DEFAULT_MARK_LAYER, null);
    let affected;
    if (withMarks === 'delete') {
        const removed = await pool.query('DELETE FROM tactical_marks WHERE lower(layer) = lower($1)', [layer.name]);
        affected = removed.rowCount;
    } else {
        const moved = await pool.query('UPDATE tactical_marks SET layer = $2 WHERE lower(layer) = lower($1)', [layer.name, defaultLayer.name]);
        affected = moved.rowCount;
    }
    await pool.query('DELETE FROM tactical_layers WHERE id = $1', [req.params.id]);
    io.emit('marks:changed', { at: Date.now() });
    return res.json({
        status: 'deleted', id: layer.id, affectedMarks: affected,
        movedTo: withMarks === 'move' ? defaultLayer.name : null,
    });
});

app.get('/api/marks/icons', authenticate, async (req, res) => {
    const result = await pool.query('SELECT id, name, created_by AS "createdBy" FROM tactical_icons ORDER BY name');
    return res.json(result.rows);
});

app.get('/api/marks/icons/:id', authenticate, async (req, res) => {
    const result = await pool.query('SELECT id, name, data, created_by AS "createdBy" FROM tactical_icons WHERE id = $1', [req.params.id]);
    if (!result.rowCount) return res.status(404).json({ error: 'Icon not found' });
    return res.json(result.rows[0]);
});

app.post('/api/marks/icons', authenticate, async (req, res) => {
    const username = await firebaseUsername(req.user);
    const { id, name, data } = isRecord(req.body) ? req.body : {};
    if (!username || typeof id !== 'string' || !ICON_ID.test(id) || typeof name !== 'string' || !name.trim()
        || name.length > 60 || typeof data !== 'string') {
        return res.status(400).json({ error: 'Invalid icon' });
    }
    const bytes = Buffer.from(data, 'base64');
    const isPng = bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    if (!isPng || bytes.length > MAX_ICON_BYTES) return res.status(400).json({ error: 'Icon must be a PNG up to 100 KB' });
    const result = await pool.query(
        `INSERT INTO tactical_icons (id, name, data, created_by) VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, data = EXCLUDED.data
         WHERE tactical_icons.created_by = EXCLUDED.created_by`,
        [id, name.trim(), data, username]
    );
    if (!result.rowCount) return res.status(409).json({ error: 'Icon id is taken' });
    io.emit('marks:changed', { at: Date.now() });
    return res.json({ id, name: name.trim() });
});

app.get('/api/rtc/ice-servers', authenticate, async (req, res) => {
    const phoneId = req.get('x-device-id');
    if (!await verifyDevice(req.user.uid, phoneId)) return res.status(403).json({ error: 'Device is not registered to this account' });
    const iceServers = stunUrls.length ? [{ urls: stunUrls }] : [];
    if (turnUrls.length) {
        const username = `${Math.floor(Date.now() / 1000) + TURN_TTL_SECONDS}:${req.user.uid}`;
        const credential = crypto.createHmac('sha1', turnSharedSecret).update(username).digest('base64');
        iceServers.push({ urls: turnUrls, username, credential });
    }
    res.set('Cache-Control', 'no-store');
    return res.json({ iceServers });
});

app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    logEvent('error', 'http_error', {
        requestId: req.id,
        message: error.message,
        status: error.status || 500,
    });
    return res.status(error.status || 500).json({ error: error.status ? 'Invalid request' : 'Internal server error' });
});

io.use(async (socket, next) => {
    try {
        const { idToken, phoneId } = socket.handshake.auth || {};
        if (typeof idToken !== 'string' || typeof phoneId !== 'string') return next(new Error('unauthorized'));
        const claims = await getAuth(firebaseApp()).verifyIdToken(idToken, true);
        if (claims.legionAccess !== true || !await verifyDevice(claims.uid, phoneId)) return next(new Error('unauthorized'));
        socket.data.uid = claims.uid;
        socket.data.phoneId = phoneId;
        return next();
    } catch {
        return next(new Error('unauthorized'));
    }
});

async function handleRtcEvent(socket, event, payload, callback) {
    const { phoneId } = socket.data;
    const reply = (value) => {
        if (typeof callback === 'function') callback(value);
    };
    if (!isRecord(payload)) return reply({ ok: false, error: 'invalid_payload' });

    try {
        if (!await rateSocketEvent(phoneId)) return reply({ ok: false, error: 'rate_limited' });
        if (event === 'rtc:call') {
            const { to, callType } = payload;
            if (typeof to !== 'string' || !to || to === phoneId || !['audio', 'video'].includes(callType)) {
                return reply({ ok: false, error: 'invalid_call_request' });
            }
            const target = await pool.query('SELECT phone_id FROM devices WHERE phone_id = $1', [to]);
            if (!target.rowCount) return reply({ ok: false, error: 'target_not_registered' });
            const callId = crypto.randomUUID();
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                await client.query(
                    'INSERT INTO calls (call_id, caller_phone_id, target_phone_id, call_type, status, expires_at) VALUES ($1, $2, $3, $4, $5, now() + ($6 * interval \'1 millisecond\'))',
                    [callId, phoneId, to, callType, 'ringing', CALL_TIMEOUT_MS]
                );
                await client.query('INSERT INTO call_participants (phone_id, call_id) VALUES ($1, $2), ($3, $2)', [phoneId, callId, to]);
                await client.query('COMMIT');
            } catch (error) {
                await client.query('ROLLBACK');
                if (error.code === '23505') return reply({ ok: false, error: 'user_busy' });
                throw error;
            } finally {
                client.release();
            }
            const caller = await pool.query(
                "SELECT COALESCE(NULLIF(callsign, ''), username) AS name FROM devices WHERE phone_id = $1",
                [phoneId]
            );
            const fromName = caller.rows[0]?.name || '';
            const incoming = { callId, from: phoneId, fromName, callType };
            const sockets = await io.in(`phone:${to}`).fetchSockets();
            if (sockets.length) {
                io.to(`phone:${to}`).emit('rtc:incoming', incoming);
            } else {
                const delivery = await sendPush([to], callType === 'video' ? 'Входящий видеозвонок' : 'Входящий аудиозвонок', 'Входящий звонок', {
                    type: 'rtc_call', callId, callerPhoneId: phoneId, callerName: fromName, callType
                });
                if (delivery.failed || delivery.skipped) {
                    await finishCall(callId, 'unreachable', [phoneId]);
                    return reply({ ok: false, error: 'target_unreachable' });
                }
            }
            return reply({ ok: true, callId, status: 'ringing' });
        }

        const callId = payload.callId;
        if (typeof callId !== 'string' || !/^[0-9a-f-]{36}$/i.test(callId)) return reply({ ok: false, error: 'invalid_call_id' });
        if (event === 'rtc:hangup' || event === 'rtc:reject') {
            const result = await pool.query(
                `SELECT c.caller_phone_id, c.target_phone_id, c.status
                 FROM calls c JOIN call_participants p USING (call_id)
                 WHERE c.call_id = $1 AND p.phone_id = $2`,
                [callId, phoneId]
            );
            const call = result.rows[0];
            if (!call) return reply({ ok: false, error: 'call_not_available' });
            if (event === 'rtc:reject' && (call.target_phone_id !== phoneId || call.status !== 'ringing')) {
                return reply({ ok: false, error: 'call_not_available' });
            }
            const peer = call.caller_phone_id === phoneId ? call.target_phone_id : call.caller_phone_id;
            await finishCall(callId, event === 'rtc:reject' ? 'rejected' : 'hangup', [peer]);
            if (event === 'rtc:reject') io.to(`phone:${peer}`).emit('rtc:rejected', { callId, reason: 'declined' });
            return reply({ ok: true });
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const call = await getCall(callId, client);
            if (!call || (event !== 'rtc:accept' && call.status !== 'accepted')) {
                await client.query('ROLLBACK');
                return reply({ ok: false, error: 'call_not_available' });
            }
            const role = call.caller_phone_id === phoneId ? 'caller' : call.target_phone_id === phoneId ? 'target' : null;
            if (!role) {
                await client.query('ROLLBACK');
                return reply({ ok: false, error: 'call_not_available' });
            }
            const destination = role === 'caller' ? call.target_phone_id : call.caller_phone_id;
            let forwardedEvent;
            let forwardedPayload;
            if (event === 'rtc:accept') {
                if (role !== 'target' || call.status !== 'ringing') {
                    await client.query('ROLLBACK');
                    return reply({ ok: false, error: 'call_not_available' });
                }
                await client.query('UPDATE calls SET status = $2, expires_at = now() + interval \'2 hours\' WHERE call_id = $1', [callId, 'accepted']);
                forwardedEvent = 'rtc:accepted';
                forwardedPayload = { callId };
            } else if (event === 'rtc:offer' || event === 'rtc:answer') {
                const description = payload.description;
                const expectedType = event === 'rtc:offer' ? 'offer' : 'answer';
                if ((event === 'rtc:offer' && role !== 'caller') || (event === 'rtc:answer' && role !== 'target') ||
                    !isRecord(description) || description.type !== expectedType ||
                    typeof description.sdp !== 'string' || description.sdp.length > MAX_SDP_LENGTH) {
                    await client.query('ROLLBACK');
                    return reply({ ok: false, error: `invalid_${expectedType}` });
                }
                forwardedEvent = event;
                forwardedPayload = { callId, from: phoneId, description };
            } else if (event === 'rtc:ice-candidate') {
                const candidate = payload.candidate;
                if (candidate !== null && (!isRecord(candidate) || typeof candidate.candidate !== 'string' ||
                    candidate.candidate.length > MAX_CALL_CANDIDATE_LENGTH)) {
                    await client.query('ROLLBACK');
                    return reply({ ok: false, error: 'invalid_ice_candidate' });
                }
                forwardedEvent = event;
                forwardedPayload = { callId, from: phoneId, candidate };
            } else {
                await client.query('ROLLBACK');
                return reply({ ok: false, error: 'unknown_event' });
            }
            await client.query('COMMIT');
            io.to(`phone:${destination}`).emit(forwardedEvent, forwardedPayload);
            return reply({ ok: true, callId });
        } finally {
            client.release();
        }
    } catch (error) {
        logEvent('error', 'rtc_signaling_failed', { message: error.message });
        return reply({ ok: false, error: 'signaling_failed' });
    }
}

io.on('connection', async (socket) => {
    const { phoneId } = socket.data;
    try {
        await socket.join(`phone:${phoneId}`);
        await pool.query('UPDATE devices SET last_seen = now() WHERE phone_id = $1', [phoneId]);
    } catch (error) {
        logEvent('error', 'socket_init_failed', { message: error.message });
        socket.disconnect(true);
        return;
    }
    if (!socket.connected) return;
    for (const event of ['rtc:call', 'rtc:accept', 'rtc:reject', 'rtc:offer', 'rtc:answer', 'rtc:ice-candidate', 'rtc:hangup']) {
        socket.on(event, (payload, callback) => handleRtcEvent(socket, event, payload, callback));
    }

    socket.on('disconnect', async () => {
        try {
            if ((await io.in(`phone:${phoneId}`).fetchSockets()).length > 0) return;
            const active = await pool.query(
                'SELECT c.call_id, c.caller_phone_id, c.target_phone_id FROM calls c JOIN call_participants p USING (call_id) WHERE p.phone_id = $1',
                [phoneId]
            );
            for (const call of active.rows) {
                const peer = call.caller_phone_id === phoneId ? call.target_phone_id : call.caller_phone_id;
                await finishCall(call.call_id, 'disconnected', [peer]);
            }
        } catch (error) {
            logEvent('error', 'socket_cleanup_failed', { message: error.message });
        }
    });
    socket.emit('rtc:ready');
});

async function expireCalls() {
    const expired = await pool.query(
        `DELETE FROM calls WHERE expires_at < now()
         RETURNING call_id, caller_phone_id, target_phone_id`
    );
    for (const call of expired.rows) {
        await pool.query('DELETE FROM call_participants WHERE call_id = $1', [call.call_id]);
        await sendCallEvent(call.caller_phone_id, 'rtc:ended', { callId: call.call_id, reason: 'no_answer' });
        await sendCallEvent(call.target_phone_id, 'rtc:ended', { callId: call.call_id, reason: 'no_answer' });
    }
}

async function purgeOldData() {
    if (!Number.isFinite(messageRetentionDays) || messageRetentionDays <= 0) return;
    const messages = await pool.query(
        `DELETE FROM messages WHERE created_at < now() - ($1::int * interval '1 day')`,
        [messageRetentionDays]
    );
    const codes = await pool.query('DELETE FROM registration_codes WHERE expires_at < now()');
    if (messages.rowCount || codes.rowCount) {
        logEvent('info', 'retention_cleanup', {
            retentionDays: messageRetentionDays,
            messagesDeleted: messages.rowCount,
            codesDeleted: codes.rowCount,
        });
    }
}

async function start() {
    if (!process.env.DATABASE_URL || !process.env.REDIS_URL || !projectId || !registrationCodeSecret || registrationCodeSecret.length < 32) {
        throw new Error('DATABASE_URL, REDIS_URL, FIREBASE_PROJECT_ID, and a 32+ character REGISTRATION_CODE_SECRET are required');
    }
    await pool.query('SELECT 1');
    await pool.query(`CREATE TABLE IF NOT EXISTS alert_responses (
        alert_id bigint NOT NULL,
        username text NOT NULL,
        status text NOT NULL DEFAULT 'confirmed',
        responded_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (alert_id, username)
    )`);
    await pool.query('CREATE INDEX IF NOT EXISTS alert_responses_alert_idx ON alert_responses (alert_id)');
    await redisSub.connect();
    io.adapter(createAdapter(redisPub, redisSub));
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(PORT, '0.0.0.0', resolve);
    });
    const expirationTimer = setInterval(() => {
        expireCalls().catch((error) => logEvent('error', 'expire_calls_failed', { message: error.message }));
    }, 5000);
    expirationTimer.unref();
    purgeOldData().catch((error) => logEvent('error', 'retention_failed', { message: error.message }));
    const retentionTimer = setInterval(() => {
        purgeOldData().catch((error) => logEvent('error', 'retention_failed', { message: error.message }));
    }, 60 * 60 * 1000);
    retentionTimer.unref();
    const autoDeleteTimer = setInterval(() => {
        purgeAutoDeleted().catch((error) => logEvent('error', 'auto_delete_failed', { message: error.message }));
    }, 60_000);
    autoDeleteTimer.unref();
    const presenceTimer = setInterval(async () => {
        try {
            const sockets = await io.fetchSockets();
            const phoneIds = [...new Set(sockets.map((item) => item.data.phoneId).filter(Boolean))];
            if (phoneIds.length) {
                await pool.query('UPDATE devices SET last_seen = now() WHERE phone_id = ANY($1::text[])', [phoneIds]);
            }
        } catch (error) {
            logEvent('error', 'presence_refresh_failed', { message: error.message });
        }
    }, 30_000);
    presenceTimer.unref();
    logEvent('info', 'server_started', { port: PORT, trustProxy: Boolean(trustProxy) });
}

async function stop() {
    io.close();
    await Promise.allSettled([redisPub.quit(), redisSub.quit(), pool.end()]);
}

if (require.main === module) {
    start().catch((error) => {
        logEvent('error', 'server_start_failed', { message: error.message });
        process.exitCode = 1;
    });
    process.once('SIGINT', () => stop().finally(() => process.exit(0)));
    process.once('SIGTERM', () => stop().finally(() => process.exit(0)));
}

module.exports = { app, start, stop, containsSensitiveField, getBearerToken, registrationCodeDigest, toFcmData };
