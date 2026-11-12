CREATE TABLE IF NOT EXISTS devices (
    phone_id text PRIMARY KEY,
    firebase_uid text NOT NULL,
    name text NOT NULL,
    fcm_token text,
    last_seen timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS devices_firebase_uid_idx ON devices (firebase_uid);
CREATE INDEX IF NOT EXISTS devices_last_seen_idx ON devices (last_seen DESC);

CREATE TABLE IF NOT EXISTS messages (
    id bigserial PRIMARY KEY,
    sender_uid text NOT NULL,
    sender_phone_id text NOT NULL REFERENCES devices (phone_id) ON DELETE CASCADE,
    sender_name text NOT NULL,
    recipient_phone_id text NOT NULL REFERENCES devices (phone_id) ON DELETE CASCADE,
    text text NOT NULL,
    data jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS messages_sender_created_idx ON messages (sender_phone_id, created_at DESC);
CREATE INDEX IF NOT EXISTS messages_recipient_created_idx ON messages (recipient_phone_id, created_at DESC);

CREATE TABLE IF NOT EXISTS calls (
    call_id uuid PRIMARY KEY,
    caller_phone_id text NOT NULL REFERENCES devices (phone_id) ON DELETE CASCADE,
    target_phone_id text NOT NULL REFERENCES devices (phone_id) ON DELETE CASCADE,
    call_type text NOT NULL CHECK (call_type IN ('audio', 'video')),
    status text NOT NULL CHECK (status IN ('ringing', 'accepted')),
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (caller_phone_id <> target_phone_id)
);

CREATE INDEX IF NOT EXISTS calls_expires_at_idx ON calls (expires_at);

CREATE TABLE IF NOT EXISTS call_participants (
    phone_id text PRIMARY KEY REFERENCES devices (phone_id) ON DELETE CASCADE,
    call_id uuid NOT NULL REFERENCES calls (call_id) ON DELETE CASCADE,
    UNIQUE (call_id, phone_id)
);

CREATE INDEX IF NOT EXISTS call_participants_call_idx ON call_participants (call_id);

CREATE TABLE IF NOT EXISTS registration_codes (
    username text PRIMARY KEY,
    code_digest char(64) NOT NULL,
    created_by text NOT NULL,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS registration_codes_expiry_idx ON registration_codes (expires_at);
