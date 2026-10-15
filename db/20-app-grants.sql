-- Least privilege for the app (#76): read and write rows, nothing else. Not the owner, so it cannot
-- ALTER, DROP or DISABLE TRIGGER (survey_versions immutability), and no TRUNCATE or TRIGGER grant.
-- Run as the owner role that runs migrations; the default privileges cover tables it creates later.
GRANT USAGE ON SCHEMA public TO plainfeedback_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO plainfeedback_app;
-- Stored answers and published versions are append-only for the app (#100): it INSERTs and
-- DELETEs (deletion) but never UPDATEs them. On a new database these tables do not exist yet, so
-- migration 0011 does the revoke there (#103); this keeps a rerun on an existing database correct.
DO $$ BEGIN
  IF to_regclass('public.responses') IS NOT NULL AND to_regclass('public.survey_versions') IS NOT NULL THEN
    REVOKE UPDATE ON responses, survey_versions FROM plainfeedback_app;
  END IF;
END $$;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO plainfeedback_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO plainfeedback_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO plainfeedback_app;
