# LegiON server

Серверная часть Android-приложения LegiON: REST API, чат, сигналинг WebRTC-звонков (Socket.IO).

- `server-dev.js` — demo-режим (без Firebase, состояние в JSON-файле). Его использует деплой по умолчанию.
- `server.js` — production (Firebase Auth/FCM, PostgreSQL, Redis), запускается через `docker-compose.yml`.
- Тесты: `node --test test/rtc-signaling.test.js test/demo-server.test.js` (нужен `npm ci`).

**Если просят развернуть / обновить сервер — следуй `deploy/CLAUDE_DEPLOY.md` строго по шагам.**
