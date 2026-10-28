-- SPDX-License-Identifier: LicenseRef-Sulla-Fair-Code
CREATE TABLE accounts.server_entitlement (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  token text,
  last_signed_check_in_at timestamptz,
  activated_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO accounts.server_entitlement(singleton) VALUES (true) ON CONFLICT DO NOTHING;

-- Defense in depth: server-mode callers must enter the centralized allocation
-- operation before creating/reactivating a membership or reserving an invite.
CREATE OR REPLACE FUNCTION accounts.require_seat_allocation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('sulla.accounts_mode', true) = 'server'
     AND current_setting('sulla.seat_allocation_authorized', true) IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'seat allocation must use the Accounts allocation domain operation' USING ERRCODE='integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER memberships_seat_allocation_guard BEFORE INSERT OR UPDATE OF revoked_at ON accounts.memberships
FOR EACH ROW WHEN (NEW.revoked_at IS NULL) EXECUTE FUNCTION accounts.require_seat_allocation_guard();
CREATE TRIGGER invitations_seat_allocation_guard BEFORE INSERT OR UPDATE OF revoked_at ON accounts.invitations
FOR EACH ROW WHEN (NEW.accepted_at IS NULL AND NEW.revoked_at IS NULL) EXECUTE FUNCTION accounts.require_seat_allocation_guard();
