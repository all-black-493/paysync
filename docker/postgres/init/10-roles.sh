#!/usr/bin/env bash
set -euo pipefail

# Passwords reach psql via \getenv so they never appear in argv.
PAYSYNC_MIGRATOR_PW="$(cat /run/secrets/db_migrator_password)"
PAYSYNC_APP_PW="$(cat /run/secrets/db_app_password)"
PAYSYNC_READONLY_PW="$(cat /run/secrets/db_readonly_password)"
export PAYSYNC_MIGRATOR_PW PAYSYNC_APP_PW PAYSYNC_READONLY_PW
: "${PAYSYNC_DB_NAME:?PAYSYNC_DB_NAME must be set}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres -v db_name="$PAYSYNC_DB_NAME" <<'SQL'
\getenv migrator_pw PAYSYNC_MIGRATOR_PW
\getenv app_pw PAYSYNC_APP_PW
\getenv readonly_pw PAYSYNC_READONLY_PW

CREATE ROLE paysync_owner NOLOGIN;

CREATE ROLE paysync_migrator LOGIN PASSWORD :'migrator_pw';
GRANT paysync_owner TO paysync_migrator WITH INHERIT FALSE, SET TRUE;
ALTER ROLE paysync_migrator SET lock_timeout = '5s';

CREATE ROLE paysync_app LOGIN PASSWORD :'app_pw'
  NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
ALTER ROLE paysync_app SET statement_timeout = '15s';
ALTER ROLE paysync_app SET lock_timeout = '5s';
ALTER ROLE paysync_app SET idle_in_transaction_session_timeout = '30s';

CREATE ROLE paysync_readonly LOGIN PASSWORD :'readonly_pw'
  NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
ALTER ROLE paysync_readonly SET default_transaction_read_only = on;
ALTER ROLE paysync_readonly SET statement_timeout = '60s';

CREATE DATABASE :"db_name" OWNER paysync_owner;
REVOKE ALL ON DATABASE :"db_name" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"db_name" TO paysync_migrator, paysync_app, paysync_readonly;

\connect :"db_name"
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
SQL
