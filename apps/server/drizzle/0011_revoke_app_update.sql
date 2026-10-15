-- #103: db/20-app-grants.sql runs before any migration, so it cannot revoke on tables that do not
-- exist yet, and its default privileges then grant UPDATE on them. Revoke here, after the tables
-- exist. Guarded: the role is created by db/10-app-role.sh, which is absent in some setups (CI).
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'plainfeedback_app') THEN
    REVOKE UPDATE ON responses, survey_versions FROM plainfeedback_app;
  END IF;
END $$;
