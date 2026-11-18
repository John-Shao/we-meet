package migrate

import (
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/we-meet/work/internal/testpg"
)

// Tests for increment 0058: the certificate record call, the renewal consumption face,
// and the re-issuance path that closes the active-without-certificate dead end.
//
// The claims these cover are the ones the increment exists for: a certificate may only
// be recorded against a pairing this device's owner already consumed; one pairing yields
// one certificate; a replacement must extend the recorded validity; the renewal face
// consumes its OWN purpose and no other; and a device whose issuance failed can still
// obtain a certificate without an operator revoke.
//
// Like the 0040 slice tests, these exercise the commands' CAS/idempotency/authority
// logic, not the cryptography: confirm only shape-checks the signature, and the real
// ES256 verification (including the renewal domain separation) is proven in
// internal/api's device certificate tests.

const recordTestPEM = "-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----\n"

// pairConfirm walks pairing and confirm and returns the device id and the pairing id,
// leaving the certificate pair NULL — which is exactly the state 0040 shipped and the
// state an issuance failure leaves behind.
func (f *deviceFixture) pairConfirm(t *testing.T, api *pgx.Conn, requestID string) (string, string) {
	t.Helper()
	return f.pairConfirmWithKey(t, api, requestID, deviceTestKeyJWK)
}

// pairConfirmWithKey is the same walk with an explicit key: one key may not bind two live
// devices (0040:1233), so a second device in the same organization needs a different JWK.
func (f *deviceFixture) pairConfirmWithKey(t *testing.T, api *pgx.Conn, requestID, jwk string) (string, string) {
	t.Helper()
	pairing := callJSON(t, api,
		`SELECT work.pair_device($1,$2,'bearer',7,$3,'desk','windows-x64',$4::jsonb)`,
		f.org, f.subject, requestID, jwk)
	challenge, _ := pairing["challenge"].(string)
	if challenge == "" {
		t.Fatalf("pairing returned no challenge: %v", pairing)
	}
	deviceID, _ := pairing["device_id"].(string)
	pairingID, _ := pairing["pairing_id"].(string)
	confirmed := callJSON(t, api,
		`SELECT work.confirm_device_pairing($1,$2,'bearer',7,$3::uuid,$4,$5,'`+deviceTestConfirmSignature+`')`,
		f.org, f.subject, pairingID, requestID+"-confirm", challenge)
	if confirmed["status"] != "active" {
		t.Fatalf("confirm status = %v, want active", confirmed["status"])
	}
	if confirmed["cert_serial"] != nil || confirmed["certificate_pem"] != nil {
		t.Fatalf("confirm must leave the certificate to the second call: %v", confirmed)
	}
	return deviceID, pairingID
}

func recordCertSQL() string {
	return `SELECT work.record_device_certificate($1,$2,'bearer',7,$3::uuid,$4::uuid,$5,$6,$7,$8)`
}

func renewRequestSQL() string {
	return `SELECT work.renew_device_certificate($1,$2,'bearer',7,$3::uuid,$4)`
}

func renewConfirmSQL() string {
	return `SELECT work.confirm_device_certificate_renewal($1,$2,'bearer',7,$3::uuid,$4,$5,'` +
		deviceTestConfirmSignature + `')`
}

// setCert writes the certificate pair directly as the maintenance connection, so a test
// can place the device inside or outside the renewal window without waiting 23 hours.
func (f *deviceFixture) setCert(t *testing.T, deviceID, serial string, notAfter time.Time) {
	t.Helper()
	mustExec(t, f.admin, "UPDATE work.device SET cert_serial = "+quoteLiteral(serial)+
		", cert_not_after = "+quoteLiteral(notAfter.UTC().Format(time.RFC3339Nano))+
		"::timestamptz WHERE org_id = "+quoteLiteral(f.org)+" AND id = "+quoteLiteral(deviceID)+"::uuid")
}

func TestR0bDeviceCertificateRecordBindsAConsumedPairingOfThisDevice(t *testing.T) {
	f := newDeviceFixture(t, "org_r0b_cert_record")
	api := f.apiConn(t)
	deviceID, pairingID := f.pairConfirm(t, api, "req-cert-1")
	notAfter := time.Now().Add(24 * time.Hour).UTC().Format(time.RFC3339Nano)

	// A renewal challenge is pending until its own confirm spends it, so it is the one
	// pairing that is both pending AND attached to an active device. Recording against
	// it must refuse: owning the device is not enough, the challenge must have been spent.
	unconsumed := callJSON(t, api, renewRequestSQL(), f.org, f.subject, deviceID, "req-cert-unconsumed")
	expectCode(t, api, "unauthorized", recordCertSQL(),
		f.org, f.subject, deviceID, unconsumed["pairing_id"], "req-rec-early", "12345", notAfter, recordTestPEM)

	// A pairing belonging to another device is not_found, never a silent cross-write.
	otherDevice, otherPairing := f.pairConfirmWithKey(t, api, "req-cert-2",
		strings.Replace(deviceTestKeyJWK, "AAAA", "CCCC", 1))
	expectCode(t, api, "not_found", recordCertSQL(),
		f.org, f.subject, otherDevice, pairingID, "req-rec-cross", "12345", notAfter, recordTestPEM)
	expectCode(t, api, "not_found", recordCertSQL(),
		f.org, f.subject, deviceID, otherPairing, "req-rec-cross-2", "12345", notAfter, recordTestPEM)

	recorded := callJSON(t, api, recordCertSQL(),
		f.org, f.subject, deviceID, pairingID, "req-rec-1", "12345", notAfter, recordTestPEM)
	if recorded["cert_serial"] != "12345" || recorded["certificate_pem"] != recordTestPEM {
		t.Fatalf("record response = %v", recorded)
	}
	if recorded["replayed"] != false {
		t.Fatalf("first record must not be a replay: %v", recorded)
	}
	if got := f.scalar(t, "SELECT cert_serial FROM work.device WHERE org_id = "+quoteLiteral(f.org)+
		" AND id = "+quoteLiteral(deviceID)+"::uuid"); got != "12345" {
		t.Fatalf("device cert_serial = %q, want 12345", got)
	}

	// The same request_id replays the recorded certificate even though the caller now
	// presents a DIFFERENT serial and PEM: the material is server-generated, so an honest
	// retry after a lost response must not become a conflict, and the response must still
	// agree with the row.
	replay := callJSON(t, api, recordCertSQL(),
		f.org, f.subject, deviceID, pairingID, "req-rec-1", "99999", notAfter, "-----BEGIN CERTIFICATE-----\nOTHER\n-----END CERTIFICATE-----\n")
	if replay["replayed"] != true || replay["cert_serial"] != "12345" || replay["certificate_pem"] != recordTestPEM {
		t.Fatalf("replay = %v, want the originally recorded certificate", replay)
	}
	if got := f.scalar(t, "SELECT cert_serial FROM work.device WHERE org_id = "+quoteLiteral(f.org)+
		" AND id = "+quoteLiteral(deviceID)+"::uuid"); got != "12345" {
		t.Fatalf("replay rewrote cert_serial to %q", got)
	}

	// One pairing yields one certificate: a second request_id against the spent pairing
	// is a conflict, not a second issuance.
	expectCode(t, api, "idempotency_key_conflict", recordCertSQL(),
		f.org, f.subject, deviceID, pairingID, "req-rec-2", "54321", notAfter, recordTestPEM)

	// A pending device cannot be given a certificate at all (device_guard's active gate).
	pending := callJSON(t, api,
		`SELECT work.pair_device($1,$2,'bearer',7,$3,'desk3','windows-x64',$4::jsonb)`,
		f.org, f.subject, "req-cert-3", strings.Replace(deviceTestKeyJWK, "AAAA", "DDDD", 1))
	expectCode(t, api, "device_revoked", recordCertSQL(),
		f.org, f.subject, pending["device_id"], pending["pairing_id"], "req-rec-pending",
		"12345", notAfter, recordTestPEM)
}

func TestR0bDeviceCertificateBoundsAndExpiryAdvance(t *testing.T) {
	f := newDeviceFixture(t, "org_r0b_cert_bounds")
	api := f.apiConn(t)
	deviceID, pairingID := f.pairConfirm(t, api, "req-bounds-1")
	good := time.Now().Add(24 * time.Hour).UTC().Format(time.RFC3339Nano)

	for _, serial := range []string{"", "0", "01", "-5", "abc", strings.Repeat("9", 40)} {
		expectCode(t, api, "invalid_request", recordCertSQL(),
			f.org, f.subject, deviceID, pairingID, "req-bounds-shape", serial, good, recordTestPEM)
	}
	expectCode(t, api, "invalid_request", recordCertSQL(),
		f.org, f.subject, deviceID, pairingID, "req-bounds-long",
		"12345", time.Now().Add(25*time.Hour).UTC().Format(time.RFC3339Nano), recordTestPEM)
	expectCode(t, api, "invalid_request", recordCertSQL(),
		f.org, f.subject, deviceID, pairingID, "req-bounds-past",
		"12345", time.Now().Add(-time.Hour).UTC().Format(time.RFC3339Nano), recordTestPEM)
	expectCode(t, api, "invalid_request", recordCertSQL(),
		f.org, f.subject, deviceID, pairingID, "req-bounds-pem", "12345", good, "")

	// Nothing above may have written the pair.
	if got := f.scalar(t, "SELECT coalesce(cert_serial,'NULL') FROM work.device WHERE org_id = "+
		quoteLiteral(f.org)+" AND id = "+quoteLiteral(deviceID)+"::uuid"); got != "NULL" {
		t.Fatalf("a refused record wrote cert_serial = %q", got)
	}

	callJSON(t, api, recordCertSQL(), f.org, f.subject, deviceID, pairingID,
		"req-bounds-ok", "12345", good, recordTestPEM)

	// A replacement must EXTEND the recorded validity. The old certificate is inside the
	// renewal window, so a renewal challenge is available; presenting an expiry at or
	// before the recorded one is the sideways rewrite 0040's comment promised to refuse
	// and never implemented.
	f.setCert(t, deviceID, "12345", time.Now().Add(30*time.Minute))
	renew := callJSON(t, api, renewRequestSQL(), f.org, f.subject, deviceID, "req-renew-bounds")
	renewPairing, _ := renew["pairing_id"].(string)
	challenge, _ := renew["challenge"].(string)
	callJSON(t, api, renewConfirmSQL(), f.org, f.subject, renewPairing, "req-renew-bounds-confirm", challenge)
	expectCode(t, api, "device_cert_must_advance", recordCertSQL(),
		f.org, f.subject, deviceID, renewPairing, "req-rec-backwards",
		"23456", time.Now().Add(20*time.Minute).UTC().Format(time.RFC3339Nano), recordTestPEM)
	// Equality is refused too, and it is tested against the value the row actually holds
	// rather than a freshly computed "now + 30m", which would drift past it.
	stored := f.scalar(t, "SELECT cert_not_after::text FROM work.device WHERE org_id = "+
		quoteLiteral(f.org)+" AND id = "+quoteLiteral(deviceID)+"::uuid")
	expectCode(t, api, "device_cert_must_advance", recordCertSQL(),
		f.org, f.subject, deviceID, renewPairing, "req-rec-sideways", "23456", stored, recordTestPEM)

	// Forward is accepted, and the serial is allowed to be numerically SMALLER: the CA
	// mints random 128-bit serials, so ordering is enforced on the expiry, not the number.
	advanced := callJSON(t, api, recordCertSQL(),
		f.org, f.subject, deviceID, renewPairing, "req-rec-forward",
		"999", time.Now().Add(24*time.Hour).UTC().Format(time.RFC3339Nano), recordTestPEM)
	if advanced["cert_serial"] != "999" {
		t.Fatalf("forward replacement = %v", advanced)
	}
}

func TestR0bDeviceRenewalFaceConsumesOnlyItsOwnPurpose(t *testing.T) {
	f := newDeviceFixture(t, "org_r0b_renew_face")
	api := f.apiConn(t)
	deviceID, pairingID := f.pairConfirm(t, api, "req-renew-1")
	f.setCert(t, deviceID, "12345", time.Now().Add(30*time.Minute))

	renew := callJSON(t, api, renewRequestSQL(), f.org, f.subject, deviceID, "req-renew-2")
	if renew["purpose"] != "renew" || renew["replayed"] != false {
		t.Fatalf("renew request = %v", renew)
	}
	renewPairing, _ := renew["pairing_id"].(string)
	challenge, _ := renew["challenge"].(string)
	if renewPairing == "" || challenge == "" {
		t.Fatalf("renew request gave no challenge: %v", renew)
	}

	// The PAIRING confirm cannot consume a renew-purpose challenge, and the renewal
	// confirm cannot consume a pair-purpose one: each selects its own purpose.
	expectCode(t, api, "not_found",
		`SELECT work.confirm_device_pairing($1,$2,'bearer',7,$3::uuid,$4,$5,'`+deviceTestConfirmSignature+`')`,
		f.org, f.subject, renewPairing, "req-cross-1", challenge)
	expectCode(t, api, "not_found", renewConfirmSQL(),
		f.org, f.subject, pairingID, "req-cross-2", challenge)

	// The renewal signing key getter is purpose-scoped the same way.
	expectCode(t, api, "not_found",
		`SELECT work.device_renewal_signing_key($1,$2,$3::uuid)`, f.org, f.subject, pairingID)
	callJSON(t, api, `SELECT work.device_renewal_signing_key($1,$2,$3::uuid)`,
		f.org, f.subject, renewPairing)

	// A wrong challenge is refused while the pairing is still pending: the state gate
	// precedes the challenge gate, so once consumed the same call would refuse as
	// unauthorized and prove nothing about the challenge binding.
	expectCode(t, api, "invalid_request:signature", renewConfirmSQL(),
		f.org, f.subject, renewPairing, "req-renew-4-confirm", strings.Repeat("f", 64))

	confirmed := callJSON(t, api, renewConfirmSQL(),
		f.org, f.subject, renewPairing, "req-renew-2-confirm", challenge)
	if confirmed["status"] != "active" || confirmed["device_id"] != deviceID {
		t.Fatalf("renewal confirm = %v", confirmed)
	}
	if confirmed["cert_serial"] != nil {
		t.Fatalf("renewal confirm must leave the certificate to the record call: %v", confirmed)
	}
	if got := f.scalar(t, "SELECT state FROM work.device_pairing WHERE org_id = "+quoteLiteral(f.org)+
		" AND id = "+quoteLiteral(renewPairing)+"::uuid"); got != "consumed" {
		t.Fatalf("renew pairing state = %q, want consumed", got)
	}

	replay := callJSON(t, api, renewConfirmSQL(),
		f.org, f.subject, renewPairing, "req-renew-2-confirm", challenge)
	if replay["replayed"] != true {
		t.Fatalf("renewal replay = %v", replay)
	}
	expectCode(t, api, "unauthorized", renewConfirmSQL(),
		f.org, f.subject, renewPairing, "req-renew-3-confirm", challenge)

	// A second subject cannot even see the pairing.
	mustExec(t, f.admin, "INSERT INTO work.member (org_id, subject_id, status, role, work_seat) VALUES ("+
		quoteLiteral(f.org)+", 'sub_other', 'active', 'member', true) ON CONFLICT DO NOTHING")
	other := connect(t, testpg.AppURL(f.dbName))
	mustExec(t, other, "SET app.org_id = "+quoteLiteral(f.org)+"; SET app.subject_id = 'sub_other'")
	expectCode(t, other, "not_found", renewConfirmSQL(),
		f.org, "sub_other", renewPairing, "req-renew-other", challenge)
	expectCode(t, other, "not_found",
		`SELECT work.device_renewal_signing_key($1,$2,$3::uuid)`, f.org, "sub_other", renewPairing)

	// The renewal face never activates anything: a pending device is refused.
	pending := callJSON(t, api,
		`SELECT work.pair_device($1,$2,'bearer',7,$3,'desk2','windows-x64',$4::jsonb)`,
		f.org, f.subject, "req-renew-pending", strings.Replace(deviceTestKeyJWK, "AAAA", "EEEE", 1))
	expectCode(t, api, "device_revoked", renewRequestSQL(),
		f.org, f.subject, pending["device_id"], "req-renew-pending-2")
}

// TestR0bDeviceRenewalReissuesWhenNoCertificateExists is the dead-end closure. Before
// 0058 an active device with a NULL certificate could neither renew (cert_not_after IS
// NULL was refused) nor re-pair (pair_device refuses a live key), so an issuance failure
// after confirm committed left a row only an operator revoke could clear.
func TestR0bDeviceRenewalReissuesWhenNoCertificateExists(t *testing.T) {
	f := newDeviceFixture(t, "org_r0b_reissue")
	api := f.apiConn(t)
	deviceID, _ := f.pairConfirm(t, api, "req-reissue-1")

	// The dead end's other half is still real: the same key cannot pair again while the
	// device is live, so re-issuance has to be reachable without a revoke.
	expectCode(t, api, "idempotency_conflict",
		`SELECT work.pair_device($1,$2,'bearer',7,$3,'desk','windows-x64',$4::jsonb)`,
		f.org, f.subject, "req-reissue-again", deviceTestKeyJWK)

	renew := callJSON(t, api, renewRequestSQL(), f.org, f.subject, deviceID, "req-reissue-2")
	renewPairing, _ := renew["pairing_id"].(string)
	challenge, _ := renew["challenge"].(string)
	if renewPairing == "" || challenge == "" {
		t.Fatalf("a certificate-less active device must still get a challenge: %v", renew)
	}
	callJSON(t, api, renewConfirmSQL(), f.org, f.subject, renewPairing, "req-reissue-2-confirm", challenge)
	recorded := callJSON(t, api, recordCertSQL(),
		f.org, f.subject, deviceID, renewPairing, "req-reissue-2-confirm|cert",
		"777", time.Now().Add(24*time.Hour).UTC().Format(time.RFC3339Nano), recordTestPEM)
	if recorded["cert_serial"] != "777" {
		t.Fatalf("re-issuance = %v", recorded)
	}

	// With a certificate now recorded, the one-hour window applies again: a fresh
	// renewal request 24h before expiry is refused, so the exemption cannot be used to
	// roll a valid certificate indefinitely.
	expectCode(t, api, "invalid_request", renewRequestSQL(),
		f.org, f.subject, deviceID, "req-reissue-3")
}

func TestR0bDeviceCertificateCommandsAreNotPublic(t *testing.T) {
	f := newDeviceFixture(t, "org_r0b_cert_acl")
	api := f.apiConn(t)
	deviceID, pairingID := f.pairConfirm(t, api, "req-acl-1")
	notAfter := time.Now().Add(24 * time.Hour).UTC().Format(time.RFC3339Nano)

	// work_worker is the gateway's role and must not be able to record a certificate or
	// consume a renewal challenge: both are work_api faces driven by the desktop session.
	worker := f.workerConn(t)
	expectCode(t, worker, "permission denied", recordCertSQL(),
		f.org, f.subject, deviceID, pairingID, "req-acl-worker", "12345", notAfter, recordTestPEM)
	expectCode(t, worker, "permission denied", renewConfirmSQL(),
		f.org, f.subject, pairingID, "req-acl-worker-2", strings.Repeat("a", 64))
	expectCode(t, worker, "permission denied",
		`SELECT work.device_renewal_signing_key($1,$2,$3::uuid)`, f.org, f.subject, pairingID)

	// No PUBLIC execute survives on any of the three, and no table privilege was granted.
	for _, name := range []string{"record_device_certificate", "confirm_device_certificate_renewal", "device_renewal_signing_key"} {
		if got := f.scalar(t, "SELECT count(*)::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace "+
			"WHERE n.nspname = 'work' AND p.proname = "+quoteLiteral(name)+
			" AND has_function_privilege('public', p.oid, 'EXECUTE')"); got != "0" {
			t.Fatalf("%s is executable by PUBLIC", name)
		}
	}
	if got := f.scalar(t, "SELECT count(*)::text FROM information_schema.role_table_grants "+
		"WHERE table_schema = 'work' AND table_name IN ('device','device_pairing') "+
		"AND grantee NOT IN ('work_owner')"); got != "0" {
		t.Fatalf("0058 granted a table privilege on device/device_pairing (%s rows)", got)
	}
}