-- Single-use, hashed tokens for email verification and password reset.
-- Accessed pre-authentication via the admin pool (anonymous verify/reset by token); RLS is enabled
-- as belt-and-suspenders for any future app-pool traffic.

CREATE TABLE auth_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type varchar(32) NOT NULL,
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX auth_tokens_token_hash_uq ON auth_tokens (token_hash);
CREATE INDEX auth_tokens_user_type_idx ON auth_tokens (user_id, type);

GRANT SELECT, INSERT, UPDATE, DELETE ON auth_tokens TO panacea_app;

ALTER TABLE auth_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY auth_tokens_self ON auth_tokens
  FOR ALL USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());
