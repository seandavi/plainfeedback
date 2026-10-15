-- Least privilege for the app (#76): read and write rows, nothing else. Not the owner, so it cannot
-- ALTER, DROP or DISABLE TRIGGER (survey_versions immutability), and no TRUNCATE or TRIGGER grant.
-- Run as the owner role that runs migrations; the default privileges cover tables it creates later.
GRANT USAGE ON SCHEMA public TO plainfeedback_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO plainfeedback_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO plainfeedback_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO plainfeedback_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO plainfeedback_app;
