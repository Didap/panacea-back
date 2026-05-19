-- Delegation system tables.
--
-- delegations: an active (or historical) grant of access between two users.
-- delegation_requests: the invitation that becomes a delegation once accepted.
-- A cascade trigger propagates revoke/expire of a parent to its active children.

CREATE TABLE delegations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delegator_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  delegate_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  parent_delegation_id uuid REFERENCES delegations(id) ON DELETE RESTRICT,
  scope varchar(32) NOT NULL DEFAULT 'full',
  status varchar(32) NOT NULL DEFAULT 'active',
  can_sub_delegate boolean NOT NULL DEFAULT false,
  expires_at timestamptz,
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  revocation_reason text,
  originating_request_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT delegations_status_check CHECK (status IN ('active', 'revoked', 'expired')),
  CONSTRAINT delegations_scope_check CHECK (scope IN ('full')),
  CONSTRAINT delegations_no_self CHECK (delegator_user_id <> delegate_user_id)
);

CREATE INDEX delegations_delegator_idx ON delegations (delegator_user_id);
CREATE INDEX delegations_delegate_idx ON delegations (delegate_user_id);
CREATE INDEX delegations_active_lookup_idx
  ON delegations (delegator_user_id, delegate_user_id)
  WHERE status = 'active';
CREATE INDEX delegations_parent_idx
  ON delegations (parent_delegation_id)
  WHERE parent_delegation_id IS NOT NULL;

-- A given pair (delegator, delegate) can have at most one active primary mandate at any time.
-- Sub-mandates (parent_delegation_id NOT NULL) are not constrained by this.
CREATE UNIQUE INDEX delegations_unique_primary_active
  ON delegations (delegator_user_id, delegate_user_id)
  WHERE status = 'active' AND parent_delegation_id IS NULL;

CREATE TABLE delegation_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requesting_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_email text NOT NULL,
  target_fiscal_code varchar(16) NOT NULL,
  target_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  parent_delegation_id uuid REFERENCES delegations(id) ON DELETE RESTRICT,
  requested_scope varchar(32) NOT NULL DEFAULT 'full',
  requested_expires_at timestamptz,
  request_can_sub_delegate boolean NOT NULL DEFAULT false,
  reason text,
  token_hash text NOT NULL,
  otp_hash text,
  otp_expires_at timestamptz,
  otp_attempts integer NOT NULL DEFAULT 0,
  status varchar(32) NOT NULL DEFAULT 'pending',
  expires_at timestamptz NOT NULL,
  sent_at timestamptz,
  accepted_at timestamptz,
  rejected_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT delegation_requests_status_check CHECK (
    status IN ('pending', 'accepted', 'rejected', 'expired', 'cancelled', 'auto_approved')
  ),
  CONSTRAINT delegation_requests_scope_check CHECK (requested_scope IN ('full')),
  CONSTRAINT delegation_requests_target_check CHECK (
    target_user_id IS NULL OR target_user_id <> requesting_user_id
  )
);

CREATE UNIQUE INDEX delegation_requests_token_uq ON delegation_requests (token_hash);
CREATE INDEX delegation_requests_requester_status_idx
  ON delegation_requests (requesting_user_id, status);
CREATE INDEX delegation_requests_target_email_status_idx
  ON delegation_requests (lower(target_email), status);
CREATE INDEX delegation_requests_target_user_status_idx
  ON delegation_requests (target_user_id, status)
  WHERE target_user_id IS NOT NULL;
CREATE INDEX delegation_requests_parent_idx
  ON delegation_requests (parent_delegation_id)
  WHERE parent_delegation_id IS NOT NULL;

ALTER TABLE delegations
  ADD CONSTRAINT delegations_originating_request_fk
  FOREIGN KEY (originating_request_id) REFERENCES delegation_requests(id) ON DELETE SET NULL;

-- Trigger: when a delegation transitions from 'active' to 'revoked' or 'expired',
-- propagate the new status to its active children. The trigger re-fires on each
-- affected child row, so the cascade reaches the full subtree.
CREATE OR REPLACE FUNCTION cascade_delegation_revoke() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> OLD.status
     AND NEW.status IN ('revoked', 'expired')
     AND OLD.status = 'active' THEN
    UPDATE delegations
    SET status = NEW.status,
        revoked_at = COALESCE(NEW.revoked_at, now()),
        revoked_by_user_id = NEW.revoked_by_user_id,
        revocation_reason = COALESCE(revocation_reason, 'parent_' || NEW.status),
        updated_at = now()
    WHERE parent_delegation_id = NEW.id
      AND status = 'active';
  END IF;
  RETURN NEW;
END$$;

CREATE TRIGGER trg_delegations_cascade_revoke
AFTER UPDATE OF status ON delegations
FOR EACH ROW
EXECUTE FUNCTION cascade_delegation_revoke();

-- updated_at maintenance: keep the column honest on every UPDATE.
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END$$;

CREATE TRIGGER trg_delegations_touch_updated_at
BEFORE UPDATE ON delegations
FOR EACH ROW
EXECUTE FUNCTION touch_updated_at();

CREATE TRIGGER trg_delegation_requests_touch_updated_at
BEFORE UPDATE ON delegation_requests
FOR EACH ROW
EXECUTE FUNCTION touch_updated_at();
