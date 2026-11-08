#!/bin/sh
set -eu
: "${IDENTITY_DB_PASSWORD:?IDENTITY_DB_PASSWORD is required}"
# PostgreSQL 17 psql reads the secret from its environment, not command arguments.
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set=ON_ERROR_STOP=1 <<'SQL'
\getenv identity_password IDENTITY_DB_PASSWORD
CREATE ROLE identity LOGIN PASSWORD :'identity_password';
CREATE SCHEMA identity AUTHORIZATION identity;
ALTER ROLE identity IN DATABASE training SET search_path TO identity;
COMMENT ON SCHEMA identity IS 'training-desk:shared-identity:v1';
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
SQL
