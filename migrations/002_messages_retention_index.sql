-- Индекс под retention-джоб: выборка и удаление старых сообщений по created_at.
CREATE INDEX IF NOT EXISTS messages_created_at_idx ON messages (created_at);
