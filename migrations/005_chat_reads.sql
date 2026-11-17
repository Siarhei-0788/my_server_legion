-- Отметки прочтения: серверное время (мс) последнего прочитанного сообщения участником.
-- chat_id без внешнего ключа: общий чат 'general' не хранится в таблице chats.
CREATE TABLE IF NOT EXISTS chat_reads (
    chat_id text NOT NULL,
    username text NOT NULL,
    read_at bigint NOT NULL,
    PRIMARY KEY (chat_id, username)
);
