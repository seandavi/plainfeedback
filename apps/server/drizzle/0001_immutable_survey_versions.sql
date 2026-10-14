CREATE FUNCTION reject_survey_version_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'survey_versions rows are immutable' USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER survey_versions_immutable
BEFORE UPDATE OR DELETE ON survey_versions
FOR EACH ROW EXECUTE FUNCTION reject_survey_version_change();
--> statement-breakpoint
CREATE TRIGGER survey_versions_no_truncate
BEFORE TRUNCATE ON survey_versions
FOR EACH STATEMENT EXECUTE FUNCTION reject_survey_version_change();
