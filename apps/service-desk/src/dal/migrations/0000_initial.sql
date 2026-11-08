CREATE TABLE IF NOT EXISTS teams (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slug text NOT NULL UNIQUE,
    name text NOT NULL, active boolean NOT NULL DEFAULT true
);
CREATE TABLE IF NOT EXISTS api_tokens (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), team_id uuid NOT NULL REFERENCES teams(id),
    hash text NOT NULL UNIQUE, username text NOT NULL, role text NOT NULL CHECK (role IN ('customer', 'agent', 'admin')),
    active boolean NOT NULL DEFAULT true, expires_at timestamptz
);
CREATE TABLE IF NOT EXISTS training_users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), team_id uuid NOT NULL REFERENCES teams(id),
    username text NOT NULL, display_name text NOT NULL, role text NOT NULL CHECK (role IN ('customer', 'agent', 'admin'))
);
CREATE UNIQUE INDEX IF NOT EXISTS user_team_name ON training_users(team_id, username);
CREATE TABLE IF NOT EXISTS issues (
    id bigserial PRIMARY KEY, team_id uuid NOT NULL REFERENCES teams(id), request_type_id text NOT NULL,
    summary text NOT NULL, description text NOT NULL, fields jsonb NOT NULL,
    reporter text NOT NULL, assignee text, status text NOT NULL DEFAULT '10005', resolution text,
    version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS issue_team_updated ON issues(team_id, updated_at, id);
CREATE TABLE IF NOT EXISTS comments (
    id bigserial PRIMARY KEY, issue_id bigint NOT NULL REFERENCES issues(id), author text NOT NULL,
    body text NOT NULL, public boolean NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS issue_history (
    id bigserial PRIMARY KEY, issue_id bigint NOT NULL REFERENCES issues(id), author text NOT NULL,
    action text NOT NULL, data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS webhook_subscriptions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), team_id uuid NOT NULL REFERENCES teams(id),
    url text NOT NULL, secret text NOT NULL, active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS webhook_outbox (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), team_id uuid NOT NULL REFERENCES teams(id),
    issue_id bigint NOT NULL REFERENCES issues(id), event text NOT NULL, payload jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
