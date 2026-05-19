-- RLS update: widen health_documents access from "owner only" to "owner OR active delegate",
-- and add RLS policies for the new delegations and delegation_requests tables.
--
-- Grants on the new tables for panacea_app are added too, so that future app-pool traffic
-- (instead of the current admin-pool shortcut) goes through RLS.

GRANT SELECT, INSERT, UPDATE, DELETE ON delegations TO panacea_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON delegation_requests TO panacea_app;

DROP POLICY IF EXISTS health_documents_owner ON health_documents;

CREATE POLICY health_documents_owner_or_delegate ON health_documents
  FOR ALL
  USING (
    owner_patient_id = app_current_user_id()
    OR EXISTS (
      SELECT 1
      FROM delegations d
      WHERE d.delegator_user_id = health_documents.owner_patient_id
        AND d.delegate_user_id = app_current_user_id()
        AND d.status = 'active'
        AND (d.expires_at IS NULL OR d.expires_at > now())
    )
  )
  WITH CHECK (
    owner_patient_id = app_current_user_id()
    OR EXISTS (
      SELECT 1
      FROM delegations d
      WHERE d.delegator_user_id = health_documents.owner_patient_id
        AND d.delegate_user_id = app_current_user_id()
        AND d.status = 'active'
        AND (d.expires_at IS NULL OR d.expires_at > now())
    )
  );

ALTER TABLE delegations ENABLE ROW LEVEL SECURITY;
ALTER TABLE delegation_requests ENABLE ROW LEVEL SECURITY;

-- Either party (delegator or delegate) can read and modify the mandate.
-- Business rules (who can revoke, who can update what) are enforced in the service layer.
CREATE POLICY delegations_party_access ON delegations
  FOR ALL
  USING (
    delegator_user_id = app_current_user_id()
    OR delegate_user_id = app_current_user_id()
  )
  WITH CHECK (
    delegator_user_id = app_current_user_id()
    OR delegate_user_id = app_current_user_id()
  );

-- A delegation_request is visible to the requester and to the target (once matched).
-- Token-based lookups by anonymous visitors at /inviti/:token go through panacea_admin.
CREATE POLICY delegation_requests_party_access ON delegation_requests
  FOR ALL
  USING (
    requesting_user_id = app_current_user_id()
    OR target_user_id = app_current_user_id()
  )
  WITH CHECK (
    requesting_user_id = app_current_user_id()
    OR target_user_id = app_current_user_id()
  );
