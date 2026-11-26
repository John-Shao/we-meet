package migrate

import "testing"

func TestPossessionProofApiCanReadOnlyTheDevicePublicKey(t *testing.T) {
	f := newUserSaveFixture(t, "org_possession_key")
	api := f.apiConn(t)
	if got := mustScalar(t, api, `SELECT has_function_privilege('work_api', 'work.device_signing_key(text,uuid)', 'EXECUTE')::text`); got != "true" {
		t.Fatalf("work_api signing-key execute = %s, want true", got)
	}
	want := mustScalar(t, f.admin, "SELECT public_key_jwk::text FROM work.device WHERE id = "+quoteLiteral(f.deviceID))
	got := mustScalar(t, api, "SELECT work.device_signing_key("+quoteLiteral(f.org)+", "+quoteLiteral(f.deviceID)+")::text")
	if got != want {
		t.Fatalf("signing key = %s, want registered public key %s", got, want)
	}
	if got := mustScalar(t, api, `SELECT has_table_privilege('work_api', 'work.device', 'SELECT')::text || '/' ||
		has_table_privilege('work_api', 'work.device_session', 'SELECT')::text`); got != "false/false" {
		t.Fatalf("work_api table privileges = %s, want false/false", got)
	}
	mustExec(t, api, "SET app.org_id = 'foreign-org'")
	if _, err := api.Exec(testContext(t), "SELECT work.device_signing_key($1,$2::uuid)", f.org, f.deviceID); err == nil {
		t.Fatal("foreign org context unexpectedly read a device key")
	}
}
