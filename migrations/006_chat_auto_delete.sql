-- Автоудаление сообщений чата через N часов (0 — выключено).
-- chat_id без внешнего ключа: общий чат 'general' не хранится в таблице chats.
CREATE TABLE IF NOT EXISTS chat_settings (
    chat_id text PRIMARY KEY,
    auto_delete_hours integer NOT NULL DEFAULT 0 CHECK (auto_delete_hours IN (0, 1, 5, 12, 24, 48))
);
