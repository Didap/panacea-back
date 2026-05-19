-- Initial schema for panacea-backend.
-- Drizzle-equivalent shape; written by hand for the bootstrap. Future changes go through drizzle-kit generate.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email varchar(320) NOT NULL,
  password_hash text NOT NULL,
  role varchar(32) NOT NULL,
  email_verified_at timestamptz,
  failed_login_attempts integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT users_role_check CHECK (role IN ('patient', 'doctor', 'institution_admin'))
);

CREATE UNIQUE INDEX users_email_active_uq ON users (email) WHERE deleted_at IS NULL;
CREATE INDEX users_role_idx ON users (role);

CREATE TABLE refresh_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  replaced_by_token_id uuid,
  ip_address text,
  user_agent text
);

CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id);
CREATE INDEX refresh_tokens_hash_idx ON refresh_tokens (token_hash);

CREATE TABLE patient_profiles (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  first_name varchar(100) NOT NULL,
  last_name varchar(100) NOT NULL,
  fiscal_code varchar(16),
  birth_date date,
  gender varchar(1),
  phone varchar(32),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT patient_profiles_gender_check CHECK (gender IS NULL OR gender IN ('M', 'F', 'X'))
);

CREATE TABLE doctor_profiles (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  first_name varchar(100) NOT NULL,
  last_name varchar(100) NOT NULL,
  fiscal_code varchar(16),
  specialization varchar(200),
  license_number varchar(64),
  phone varchar(32),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE health_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_patient_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  uploaded_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  category varchar(64) NOT NULL,
  title varchar(255) NOT NULL,
  notes text,
  file_name varchar(255) NOT NULL,
  mime_type varchar(127) NOT NULL,
  size_bytes integer NOT NULL,
  storage_driver varchar(32) NOT NULL,
  storage_key text NOT NULL,
  taken_at date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT health_documents_category_check CHECK (
    category IN (
      'referto', 'esame_laboratorio', 'esame_strumentale',
      'ricetta', 'lettera_dimissione', 'certificato', 'altro'
    )
  )
);

CREATE INDEX health_documents_owner_idx ON health_documents (owner_patient_id);
CREATE INDEX health_documents_category_idx ON health_documents (category);

CREATE TABLE audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid,
  actor_role varchar(32),
  action varchar(64) NOT NULL,
  target_type varchar(64),
  target_id uuid,
  ip_address text,
  user_agent text,
  request_id text,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_logs_actor_idx ON audit_logs (actor_user_id);
CREATE INDEX audit_logs_action_idx ON audit_logs (action);
CREATE INDEX audit_logs_target_idx ON audit_logs (target_type, target_id);
CREATE INDEX audit_logs_created_idx ON audit_logs (created_at);
