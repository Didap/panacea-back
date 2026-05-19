-- Row-level security skeleton.
-- panacea_admin is the migration/ops role (bypasses RLS via BYPASSRLS).
-- panacea_app is the application role; every connection sets app.current_user_id per transaction
-- and policies filter rows to the row owner or, post-delegation, to authorized doctors.

CREATE ROLE panacea_app NOINHERIT LOGIN PASSWORD 'panacea_app';
ALTER ROLE panacea_app SET search_path = public;
GRANT CONNECT ON DATABASE panacea TO panacea_app;
GRANT USAGE ON SCHEMA public TO panacea_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO panacea_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO panacea_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO panacea_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO panacea_app;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'panacea_admin') THEN
    CREATE ROLE panacea_admin LOGIN BYPASSRLS PASSWORD 'panacea_admin';
  ELSE
    ALTER ROLE panacea_admin BYPASSRLS;
  END IF;
END$$;

-- A helper that returns the current actor id, or NULL when unset.
CREATE OR REPLACE FUNCTION app_current_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_user_id', true), '')::uuid
$$;

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE patient_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE doctor_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE health_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE refresh_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY users_self ON users
  FOR SELECT USING (id = app_current_user_id());

CREATE POLICY patient_profiles_self ON patient_profiles
  FOR ALL USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());

CREATE POLICY doctor_profiles_self ON doctor_profiles
  FOR ALL USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());

CREATE POLICY health_documents_owner ON health_documents
  FOR ALL USING (owner_patient_id = app_current_user_id())
  WITH CHECK (owner_patient_id = app_current_user_id());

CREATE POLICY refresh_tokens_self ON refresh_tokens
  FOR ALL USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());

CREATE POLICY audit_logs_self_read ON audit_logs
  FOR SELECT USING (actor_user_id = app_current_user_id());
