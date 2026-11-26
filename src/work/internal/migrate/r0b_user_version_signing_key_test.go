package migrate

import "testing"

func TestUserVersionSigningKeyIsOwnerSessionScoped(t *testing.T) {
	f := newUserSaveFixture(t, "org_user_version_key")
	api := f.apiConn(t)
	want := mustScalar(t, f.admin, "SELECT public_key_jwk::text FROM work.device WHERE id = "+quoteLiteral(f.deviceID))
	got := mustScalar(t, api, "SELECT work.user_version_signing_key("+
		quoteLiteral(f.org)+", "+quoteLiteral(f.subject)+", "+quoteLiteral(f.deviceID)+", "+quoteLiteral(f.sessionID)+")::text")
	if got != want {
		t.Fatalf("signing key = %s, want registered device key %s", got, want)
	}
	if got := mustScalar(t, api, `SELECT has_table_privilege('work_api', 'work.device_session', 'SELECT')::text || '/' ||
		has_table_privilege('work_api', 'work.device', 'SELECT')::text`); got != "false/false" {
		t.Fatalf("work_api table privileges = %s, want false/false", got)
	}
	if got := mustScalar(t, api, `SELECT count(*)::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
		WHERE n.nspname = 'work' AND p.proname = 'user_version_signing_key'
		  AND p.prosecdef AND p.proowner = (SELECT oid FROM pg_roles WHERE rolname = 'work_owner')`); got != "1" {
		t.Fatalf("owner-scoped definer getter count = %s, want 1", got)
	}

	call := func(subject, device, session string) {
		t.Helper()
		_, err := api.Exec(testContext(t), "SELECT work.user_version_signing_key($1,$2,$3::uuid,$4::uuid)",
			f.org, subject, device, session)
		if err == nil {
			t.Fatalf("foreign/expired key lookup unexpectedly succeeded: subject=%s device=%s session=%s", subject, device, session)
		}
	}
	call("another-subject", f.deviceID, f.sessionID)
	call(f.subject, newUUID(t), f.sessionID)
	call(f.subject, f.deviceID, newUUID(t))

	mustExec(t, f.admin, "UPDATE work.device_session SET expires_at = created_at + interval '1 microsecond' WHERE id = "+quoteLiteral(f.sessionID))
	call(f.subject, f.deviceID, f.sessionID)
}
