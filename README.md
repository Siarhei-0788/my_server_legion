# Legion server

The server provides authenticated device registration, Firebase Cloud Messaging (FCM), message persistence, and one-to-one WebRTC signaling. PostgreSQL stores devices, messages, registration codes, and active calls. Redis distributes Socket.IO events across server instances. WebRTC media is exchanged directly between devices or through coturn; the Node server only relays signaling.

## Requirements

- Node.js 24+ for local execution, or Docker Compose.
- A Firebase project with Email/Password sign-in and Firebase Cloud Messaging enabled.
- PostgreSQL and Redis.
- For reliable calls across mobile networks/NATs, a public coturn host, a static authentication secret, and valid TLS certificates.

## Configure and run with Docker Compose

1. Copy `.env.example` to `.env` and set unique, strong values for the database password, `REGISTRATION_CODE_SECRET` (at least 32 characters), and `TURN_SHARED_SECRET`.
2. Set `FIREBASE_PROJECT_ID` to the Firebase project ID. Put a Firebase service-account JSON file at the path in `FIREBASE_SERVICE_ACCOUNT_FILE`; keep it outside source control.
3. Configure `TURN_REALM`, `TURN_URLS`, and the TLS certificate/key paths for your public TURN host. Set `TURN_EXTERNAL_IP` to `PUBLIC_IP/172.30.0.10`; coturn has a fixed address on the Compose network for correct public-to-container address mapping. If you change the Compose subnet or coturn address, update both values. Open TCP/UDP 3478, TLS 5349, and the configured UDP relay port range (49160-49200) in the host firewall and cloud firewall. The TURN host must be reachable from clients.
4. Start the services with `docker compose up --build -d`. The app container applies `migrations/001_init.sql` before listening on port 3000.
5. Put HTTPS/WSS termination in front of the app for production. Do not expose the HTTP service directly to the public internet without TLS.

PostgreSQL and Redis data are stored in Compose named volumes. Back up these volumes according to your deployment policy.

## Run locally

Install dependencies with `npm ci`, configure `DATABASE_URL`, `REDIS_URL`, `FIREBASE_PROJECT_ID`, `REGISTRATION_CODE_SECRET`, and `GOOGLE_APPLICATION_CREDENTIALS`, then run:

```powershell
node migrate.js
node server.js
```

Set `PORT` to change the default HTTP port (3000). `STUN_URLS` defaults to Google's public STUN server. Set `TURN_URLS` and `TURN_SHARED_SECRET` together to issue short-lived coturn credentials. `TURN_CREDENTIAL_TTL_SECONDS` defaults to 3600, and `RTC_CALL_TIMEOUT_MS` defaults to 60000. Restrict browser origins with the comma-separated `CORS_ORIGINS`; native Android clients do not send an Origin header.

## Firebase identities and access

The Android client signs in through Firebase Authentication and sends Firebase ID tokens. Create or enable user accounts in the configured Firebase project, then grant service access to each approved UID:

```powershell
node scripts/set-firebase-claims.js <firebase-uid> grant user
```

To grant administrator access, use `grant admin`. Only administrators can create registration codes and send direct administrative pushes. Revoke service access with `revoke user`. Custom claims are included in ID tokens; users should sign in again after claims change.

Generate a registration code in the Android administrator UI; the app submits its username and code to the server:

```http
POST /api/registration-codes
Authorization: Bearer <Firebase-ID-token>
Content-Type: application/json

{"username":"callsign","code":"ABC123"}
```

Share the generated code with the user, who enters it in the Android registration flow. Verify it with `POST /api/registration-codes/verify` and `{"username":"callsign","code":"..."}`. Codes expire after 24 hours and are stored as HMAC digests.

For Android builds, add these values to `~/.gradle/gradle.properties` (do not commit the file):

```properties
LEGION_FIREBASE_API_KEY=...
LEGION_FIREBASE_APP_ID=...
LEGION_FIREBASE_PROJECT_ID=...
LEGION_FIREBASE_SENDER_ID=...
```

The Android app must use the same Firebase project as the server. Device registration includes the current FCM token, and `onNewToken` refreshes it. Android 13+ requires notification permission. Data-only incoming-call pushes let the app display its own call notification while backgrounded; Android does not deliver messages to an app that the user force-stopped until the app is opened again.

## HTTP API

All endpoints except `/health` and `/ready` require a Firebase Bearer ID token and a `legionAccess=true` custom claim. Device endpoints also verify `X-Device-ID` is registered to the authenticated Firebase UID.

| Method and path | Purpose |
|---|---|
| `GET /health/live` | Liveness check |
| `GET /health/ready` | PostgreSQL/Redis readiness check |
| `POST /api/register` | Register/refresh the caller's device, call sign, and FCM token |
| `GET /api/phones` | List other registered devices with an FCM token and their call signs/presence |
| `GET /api/phone/:id` | Look up another registered device |
| `GET /api/users` | List registered users with call signs and online status |
| `GET /api/chats` | List chats available to the authenticated user |
| `POST /api/chats` | Create a chat |
| `DELETE /api/chats/:id` | Delete a chat created by the authenticated user |
| `GET /api/rtc/ice-servers` | Return STUN and temporary TURN credentials |
| `POST /api/send` | Persist and push a message to registered device(s) |
| `GET /api/messages` | Read messages delivered to the authenticated device |
| `GET /api/admin/users` | List active users (administrator only) |
| `POST /api/registration-codes` | Create a code (administrator only) |
| `POST /api/registration-codes/verify` | Verify a registration code |
| `POST /api/push` | Send a direct push (administrator only) |

`POST /api/send` accepts a JSON object with `to`, `text`, and optional `data`; it does not accept credentials or password fields. `POST /api/push` accepts `to`, `title`, `body`, and optional `data`. Target `to` with a device ID, or use `"all"` where supported. FCM data values are sent as strings.

The authenticated user's call sign is refreshed during device registration. A user is considered online when a device has made an authenticated API request within the last two minutes.

The Android client keeps chat history scoped by the server chat ID. `/api/messages` returns messages delivered to the requesting device; sender-side local echoes are not returned. Attachments are currently embedded in encrypted message text and limited by the client to 6 MiB per file.

## WebRTC signaling

Connect Socket.IO over WebSocket to the HTTPS origin using handshake auth `{ "idToken": "<Firebase-ID-token>", "phoneId": "<registered-device-id>" }`. The server validates both the Firebase claim and device ownership, joins the device room, then emits `rtc:ready`; wait for this event before sending signaling events. The Android app obtains ICE servers from `GET /api/rtc/ice-servers` before creating a peer connection.

| Direction | Event | Payload |
|---|---|---|
| Client → server | `rtc:call` | `{ "to": "<device-id>", "callType": "audio" }` or `"video"` |
| Server → callee | `rtc:incoming` | `{ "callId": "...", "from": "<device-id>", "callType": "audio" }` |
| Callee → server | `rtc:accept` / `rtc:reject` | `{ "callId": "..." }` |
| Server → caller | `rtc:accepted` / `rtc:rejected` | `{ "callId": "..." }` |
| Caller → server → callee | `rtc:offer` | `{ "callId": "...", "description": { "type": "offer", "sdp": "..." } }` |
| Callee → server → caller | `rtc:answer` | `{ "callId": "...", "description": { "type": "answer", "sdp": "..." } }` |
| Either client → server → peer | `rtc:ice-candidate` | `{ "callId": "...", "candidate": { "candidate": "...", "sdpMid": "...", "sdpMLineIndex": 0 } }` |
| Either client → server → peer | `rtc:hangup` | `{ "callId": "..." }` |
| Server → participants | `rtc:ended` | `{ "callId": "...", "reason": "..." }` |

Use Socket.IO acknowledgements; responses contain `{ "ok": true }` or `{ "ok": false, "error": "..." }`. Call setup also returns `callId`. Calls are one-to-one, expire after the configured ringing timeout, and are ended when the last socket for a participant disconnects. Active call state is persisted in PostgreSQL; Redis distributes events between server instances.

When the callee is offline, the server sends a data-only FCM notification containing `type=rtc_call`, `callId`, `callerPhoneId`, and `callType`. This is why the device list includes registered devices with an FCM token even when their last connection is old. The Android notification's accept action opens the call UI and accepts the existing call; rejecting from the notification sends `rtc:reject`.

STUN alone cannot reliably connect peers behind restrictive NATs or mobile networks. Deploy coturn for production, configure its realm/secret to match the server, and test UDP/TCP/TLS reachability from real mobile networks. If direct connectivity fails, verify TURN relay traffic and firewall rules before diagnosing the Android client.

## Tests and operational notes

The default test command runs the unit, demo-server, and RTC signaling suites.
Production integration tests are reported as skipped unless PostgreSQL and Redis
test URLs are configured:

```powershell
npm test
```

Unit tests need nothing but Node.js:

```powershell
npm run test:unit          # чистые функции: токены, фильтр полей, digest кодов, FCM-payload
```

Integration tests need reachable PostgreSQL and Redis; without `TEST_DATABASE_URL`
and `TEST_REDIS_URL` they are skipped, so local runs without Docker stay green:

```powershell
$env:TEST_DATABASE_URL='postgres://legion:legion@127.0.0.1:5432/legion_test'
$env:TEST_REDIS_URL='redis://127.0.0.1:6379'
npm run test:integration   # миграции, /health/live, /health/ready, 401, x-request-id
```

CI runs both on every change (`.github/workflows/server-ci.yml`) with PostgreSQL and
Redis service containers.

### Retention

Messages older than `MESSAGE_RETENTION_DAYS` (default 30) are deleted hourly, together
with expired registration codes; `0` disables deletion. The cleanup writes a
`retention_cleanup` log record with the number of removed rows.

### Structured logs

Every request gets an `X-Request-Id` (echoed from the proxy when valid, generated
otherwise) and produces one JSON line:

```json
{"ts":"2026-01-01T10:00:00.000Z","level":"info","event":"http_request","requestId":"...","method":"GET","path":"/health/live","status":200,"durationMs":1.2}
```

Errors carry the same `requestId`. Set `TRUST_PROXY=1` (or a hop count) behind
nginx/Caddy so client IPs — and therefore rate limiting — stay per-client.

`node --check server.js` validates syntax, and `npm audit` checks the dependency tree.
End-to-end auth, push, and WebRTC tests require reachable Firebase and TURN
configuration; do not treat unit/integration checks as proof those services are
configured. The Compose stack is intended to run behind a TLS reverse proxy and is not
a substitute for Firebase project setup, certificate provisioning, backups, monitoring,
or host firewall configuration.
