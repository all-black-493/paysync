GRANT SELECT, INSERT, UPDATE, DELETE ON auth.apikey TO paysync_app;

-- Better Auth plugins add tables over time; the app role gets the same access to each.
ALTER DEFAULT PRIVILEGES FOR ROLE paysync_owner IN SCHEMA auth
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO paysync_app;
