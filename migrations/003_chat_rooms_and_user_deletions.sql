ALTER TABLE devices ADD COLUMN IF NOT EXISTS username text;
CREATE INDEX IF NOT EXISTS devices_username_idx ON devices (username);

CREATE TABLE IF NOT EXISTS chats (
    chat_id text PRIMARY KEY,
    name text NOT NULL,
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chat_members (
    chat_id text NOT NULL REFERENCES chats (chat_id) ON DELETE CASCADE,
    username text NOT NULL,
    PRIMARY KEY (chat_id, username)
);

CREATE INDEX IF NOT EXISTS chat_members_username_idx ON chat_members (username);

CREATE TABLE IF NOT EXISTS deleted_users (
    username text PRIMARY KEY,
    deleted_at timestamptz NOT NULL DEFAULT now()
);
