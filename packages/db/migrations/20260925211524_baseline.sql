CREATE SCHEMA ingest;
CREATE SCHEMA core;
CREATE SCHEMA ledger;
CREATE SCHEMA agent;
CREATE SCHEMA audit;
CREATE SCHEMA stream;

GRANT USAGE ON SCHEMA ingest, core, ledger, agent, audit, stream TO paysync_app;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
