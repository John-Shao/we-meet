// 2026-11-18 (GW20). Until this batch the device clientAuth certificate was NEVER issued in
// production code: confirm_device_pairing hardcoded certificate_pem/cert_serial/cert_not_after
// to null, the "second call" 0040:1374-1377 promised had no implementation anywhere, and
// purpose='renew' had a producer but no consumer — so the renewal face was permanently refused.
// Worse, an issuance failure after confirm committed left a device that could neither renew
// (cert_not_after IS NULL) nor re-pair (one live device per key), i.e. an operator-revoke-only
// dead end. This gate pins the four faces that close that, and the two MEASURED facts that a
// plausible "simplification" would silently undo:
//   - the 24h expiry bound cannot be exact: the expiry is stamped by the API host's CA while
//     the bound is evaluated against the DATABASE clock (68ms apart measured locally, plus the
//     CA's one-minute NotBefore backdate), so an exact bound refuses every honest certificate;
//   - the record call's request hash must EXCLUDE the certificate material, because that
//     material is server-generated: an honest retry re-signs with a fresh random serial, and
//     hashing it in would turn every retry into idempotency_key_conflict.
// It also pins the domain separation §2.1 requires (a pairing signature must not be replayable
// as a renewal) and the fail-closed ordering (no CA => refuse BEFORE any database write).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(HERE, '..', '..', '..', '..', '..');
const WORK = join(ROOT, 'src', 'work');
const MIGRATIONS = join(WORK, 'migrations');
const INCREMENTS = join(MIGRATIONS, 'increments');
const API = join(WORK, 'internal', 'api');
const read = (p) => readFileSync(p, 'utf8');
const goCode = (t) => t.split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join('\n');
const sqlCode = (t) => t.split(/\r?\n/).filter((l) => !/^\s*--/.test(l)).join('\n');
const sha256 = (p) => 'sha256:' + createHash('sha256').update(readFileSync(p)).digest('hex');
// handlerBody slices one Go handler out so an ordering assertion is about THAT handler.
const handlerBody = (src, name) => {
  const start = src.indexOf(`func (s *Server) ${name}(`);
  assert.ok(start >= 0, `handler ${name} is gone`);
  const rest = src.slice(start + 10);
  const next = rest.indexOf('\nfunc ');
  return next < 0 ? rest : rest.slice(0, next);
};

const INC = join(INCREMENTS, '0058_device_certificate_issuance.sql');
const DEVICES = join(API, 'devices.go');
const BOOTSTRAP = join(API, 'bootstrap.go');
const LOAD = join(WORK, 'internal', 'deviceca', 'load.go');
const RENEWAL_SIG = join(WORK, 'internal', 'devicesig', 'certrenewal.go');
const PAIRING_SIG = join(WORK, 'internal', 'devicesig', 'pairing.go');
const MAIN = join(WORK, 'cmd', 'work-api', 'main.go');
const ENV = join(WORK, 'deploy', 'ecs', 'work-api.env.example');

for (const p of [INC, DEVICES, BOOTSTRAP, LOAD, RENEWAL_SIG, PAIRING_SIG, MAIN, ENV]) {
  assert.ok(existsSync(p), `missing ${p}`);
}

test('0058 is landed as a full increment: catalog, manifest and both hand-copies', () => {
  const manifest = JSON.parse(read(join(MIGRATIONS, 'manifest.json')));
  const tail = manifest.increments.find((entry) => entry.version === 58);
  assert.ok(tail, 'the certificate issuance increment is missing');
  assert.equal(tail.version, 58);
  assert.equal(tail.name, '0058_device_certificate_issuance');
  assert.equal(tail.checksum, sha256(INC), 'the increment body moved without re-pinning its checksum');
  const catalog = join(MIGRATIONS, tail.catalog);
  assert.ok(existsSync(catalog), 'the tail catalog checkpoint is missing');
  assert.equal(tail.catalog_checksum, sha256(catalog), 'the catalog moved without re-pinning');
  // The two hand-copied (version, name) lists are the radius that a new increment must pay.
  assert.match(read(join(WORK, 'internal', 'migrate', 'manifest_test.go')),
    /"0058_device_certificate_issuance",/);
  assert.match(read(join(WORK, 'deploy', 'ecs', 'verify-r0a-0027.sh')),
    /\(58, '0058_device_certificate_issuance'\)/);
  const scope = JSON.parse(read(join(HERE, '..', 'r0b-audit-scope.json')));
  assert.equal(scope.chainTip, Math.max(...manifest.increments.map((entry) => entry.version)));
  const names = scope.entries.map((e) => e.name);
  for (const entry of ['record_device_certificate', 'confirm_device_certificate_renewal',
    'device_renewal_signing_key', 'POST /work/v2/devices/certificate-renewals/{pairingId}/confirm']) {
    assert.ok(names.includes(entry), `${entry} is a new J39 surface and must be in the audit scope`);
  }
});

test('the record call is the second call: it binds a consumed pairing and never signs', () => {
  const sql = sqlCode(read(INC));
  const start = sql.indexOf('CREATE FUNCTION work.record_device_certificate(');
  assert.ok(start >= 0, 'record_device_certificate is gone');
  const body = sql.slice(start, sql.indexOf('REVOKE ALL ON FUNCTION work.record_device_certificate'));
  assert.match(body, /IF v_pairing\.state <> 'consumed' THEN\s*\n\s*RAISE EXCEPTION 'unauthorized'/);
  assert.match(body, /IF v_device\.status <> 'active' THEN\s*\n\s*RAISE EXCEPTION 'device_revoked'/);
  assert.match(body, /AND device_id = p_device_id AND owner_subject_id = p_actor_subject_id/);
  // One pairing yields one certificate.
  assert.match(body, /action = 'device\.cert\.recorded'\s*\n\s*AND metadata ->> 'pairing_id' = p_pairing_id::text/);
  // The request hash binds the identity scope ONLY. Including the server-generated serial or
  // PEM would make every honest retry a conflict (the CA re-signs with a fresh random serial).
  assert.match(body, /v_request_hash := work\.sha256_text\('device\.cert\.record\|' \|\| p_device_id::text\s*\n\s*\|\| '\|' \|\| p_pairing_id::text\)/);
  const hashLine = body.slice(body.indexOf('v_request_hash :='), body.indexOf('SELECT metadata INTO v_receipt'));
  assert.ok(!hashLine.includes('p_cert_serial') && !hashLine.includes('p_certificate_pem'),
    'the record request hash must not bind server-generated certificate material');
  // The replay returns the recorded certificate, so the response and the row cannot disagree.
  assert.match(body, /RETURN \(v_receipt -> 'response'\) \|\| jsonb_build_object\('replayed', true\)/);
  // No cryptography here: §4.3 keeps the CA call outside every transaction.
  assert.ok(!/pgcrypto|sign\(|ecdsa/i.test(body), 'the record command must not sign anything');
});

test('the 24h bound carries the measured clock-skew tolerance', () => {
  const sql = sqlCode(read(INC));
  assert.match(sql, /p_cert_not_after > now\(\) \+ interval '24 hours' \+ interval '5 minutes'/);
  assert.match(sql, /IF p_cert_not_after <= now\(\)/);
  // An exact bound is the race this batch measured; it must not come back as a "tidy-up".
  assert.ok(!/p_cert_not_after > now\(\) \+ interval '24 hours' THEN/.test(sql),
    'an exact 24h bound refuses every honestly issued certificate across two clocks');
  // The reason stays written down next to the tolerance.
  assert.match(read(INC), /68ms measured locally/);
  assert.match(read(INC), /backdates NotBefore by one minute/);
});

test('the renewal window exempts only a device that has NO certificate', () => {
  const sql = sqlCode(read(INC));
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION work.renew_device_certificate(');
  assert.ok(start >= 0, 'renew_device_certificate was not restated');
  const body = sql.slice(start);
  assert.match(body, /IF v_device\.cert_not_after IS NOT NULL\s*\n\s*AND v_device\.cert_not_after - now\(\) > interval '1 hour' THEN/);
  // The unconditional NULL refusal is what bricked the device; it must be gone.
  assert.ok(!/IF v_device\.cert_not_after IS NULL\s*\n\s*OR v_device\.cert_not_after - now\(\)/.test(body),
    'the old NULL refusal is back, so an issuance failure is an operator-revoke-only dead end');
  // Every other precondition is unchanged.
  assert.match(body, /IF v_device\.status <> 'active' THEN\s*\n\s*RAISE EXCEPTION 'device_revoked'/);
  assert.match(body, /'renew', work\.sha256_text\(v_challenge\), v_device\.public_key_thumbprint/);
  assert.match(body, /SECURITY DEFINER/);
  assert.match(body, /SET search_path = work, pg_catalog/);
  // The dead end's other half is still real and is why the exemption is needed.
  const pairing = sqlCode(read(join(INCREMENTS, '0040_device_identity_and_workspace_grants.sql')));
  assert.match(pairing, /AND status <> 'revoked'\) THEN\s*\n\s*RAISE EXCEPTION 'idempotency_conflict'/);
});

test('the renewal consumer is its own function with its own purpose and domain', () => {
  const sql = sqlCode(read(INC));
  const start = sql.indexOf('CREATE FUNCTION work.confirm_device_certificate_renewal(');
  assert.ok(start >= 0, 'confirm_device_certificate_renewal is gone');
  const body = sql.slice(start, sql.indexOf('REVOKE ALL ON FUNCTION work.confirm_device_certificate_renewal'));
  assert.match(body, /AND owner_subject_id = p_actor_subject_id AND purpose = 'renew'/);
  assert.match(body, /v_canonical := 'work-device-cert-renew-v2\|' \|\| p_pairing_id::text/);
  assert.match(body, /IF v_device\.status <> 'active' THEN/);
  // Renewal never activates and never writes the certificate pair itself.
  assert.ok(!/UPDATE work\.device\s*\n\s*SET status/.test(body), 'the renewal confirm must not activate');
  assert.ok(!/SET cert_serial/.test(body), 'the renewal confirm must leave the pair to the record call');
  // The shipped pairing path is untouched: 0046 still selects purpose='pair' only.
  const shipped = sqlCode(read(join(INCREMENTS, '0046_device_pairing_signature_verify.sql')));
  assert.match(shipped, /AND owner_subject_id = p_actor_subject_id AND purpose = 'pair'/);
  assert.ok(!shipped.includes("'renew'"), '0046 must not be widened to the renewal purpose');
  assert.ok(!sql.includes('CREATE OR REPLACE FUNCTION work.confirm_device_pairing'),
    '0058 must not restate the shipped pairing confirm');
  // The getter is purpose-scoped the same way, and 0046's getter is left alone.
  assert.match(sql, /CREATE FUNCTION work\.device_renewal_signing_key\(/);
  assert.ok(!sql.includes('CREATE OR REPLACE FUNCTION work.device_pairing_signing_key'));
});

test('the expiry-advance guard is enforced for every writer, and its code is registered', () => {
  const sql = sqlCode(read(INC));
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION work.device_guard()');
  assert.ok(start >= 0, 'device_guard was not restated');
  const body = sql.slice(start, sql.indexOf('CREATE FUNCTION work.device_renewal_signing_key'));
  assert.match(body, /IF OLD\.cert_serial IS NOT NULL\s*\n\s*AND NEW\.cert_serial IS DISTINCT FROM OLD\.cert_serial\s*\n\s*AND NEW\.cert_not_after <= OLD\.cert_not_after THEN\s*\n\s*RAISE EXCEPTION 'device_cert_must_advance'/);
  // The active gate and the immutability checks are restated, not dropped.
  assert.match(body, /RAISE EXCEPTION 'device_cert_requires_active'/);
  assert.match(body, /RAISE EXCEPTION 'device_content_immutable'/);
  assert.match(body, /RAISE EXCEPTION 'device_revoked_at_immutable'/);
  const catalog = JSON.parse(read(join(WORK, 'contracts', 'error-codes.json')));
  assert.equal(catalog.db_exception_map.device_cert_must_advance, 'invalid_request',
    '23514 falls back to invalid_request; a nicer status would be an undecided response move');
  // Serial ORDERING is deliberately not enforced: the CA mints random 128-bit serials.
  assert.match(read(INC), /random 128-bit serials/);
  assert.ok(!/NEW\.cert_serial::numeric > OLD\.cert_serial::numeric/.test(body),
    'a numeric serial ordering would refuse legitimate renewals');
});

test('the certificate face fails closed BEFORE any database work when no CA is wired', () => {
  const src = goCode(read(DEVICES));
  for (const name of ['confirmDevicePairing', 'renewDeviceCertificate', 'confirmDeviceCertificateRenewal']) {
    const body = handlerBody(src, name);
    const guard = body.indexOf('requireDeviceCA');
    const firstDB = body.indexOf('WithWorkContext');
    assert.ok(guard >= 0, `${name} does not require a device CA`);
    assert.ok(firstDB < 0 || guard < firstDB,
      `${name} touches the database before checking the CA; a refusal would leave an activatable row`);
  }
  const guard = handlerBody(src, 'requireDeviceCA');
  assert.match(guard, /if s\.deviceCA == nil \{\s*\n\s*writeAPIError\(w, correlationID, apierr\.New\("service_degraded"\)\)/);
  // Activating first is the dead end: the reason stays written down.
  assert.match(read(DEVICES), /cannot connect \(mTLS needs the cert\) and cannot be/);
});

test('the CA signs outside the transaction and the record is a separate call', () => {
  const src = goCode(read(DEVICES));
  const body = handlerBody(src, 'issueAndRecordDeviceCert');
  const sign = body.indexOf('IssueDeviceCert');
  const tx = body.indexOf('WithWorkContext');
  assert.ok(sign >= 0 && tx >= 0 && sign < tx,
    'the CA call must precede the record transaction (§4.3: external calls never inside a transaction)');
  assert.match(body, /SELECT work\.record_device_certificate\(/);
  assert.match(body, /confirmRequestID\+"\|cert"/);
  // The response carries the chain the device installs, leaf first.
  assert.match(body, /for _, der := range chain\.Certificate \{/);
  assert.match(body, /pem\.EncodeToMemory\(&pem\.Block\{Type: "CERTIFICATE", Bytes: der\}\)/);
  // Both confirm faces merge the record response and keep the CONFIRM replay flag.
  for (const name of ['confirmDevicePairing', 'confirmDeviceCertificateRenewal']) {
    const h = handlerBody(src, name);
    assert.match(h, /issueAndRecordDeviceCert\(/);
    assert.match(h, /recorded\["replayed"\] = confirmed\["replayed"\]/);
  }
  assert.match(handlerBody(src, 'confirmDeviceCertificateRenewal'), /devicesig\.VerifyCertRenewal\(/);
  assert.match(handlerBody(src, 'confirmDeviceCertificateRenewal'), /work\.device_renewal_signing_key\(/);
  assert.match(handlerBody(src, 'confirmDevicePairing'), /devicesig\.VerifyPairing\(/);
});

test('the renewal signature domain is separate and rebuilt identically on both sides', () => {
  const renewal = goCode(read(RENEWAL_SIG));
  const pairing = goCode(read(PAIRING_SIG));
  assert.match(renewal, /const CertRenewalDomain = "work-device-cert-renew-v2"/);
  assert.match(pairing, /const PairingDomain = "work-device-pair-v2"/);
  assert.match(renewal, /return CertRenewalDomain \+ "\|" \+ pairingID \+ "\|" \+ challenge \+ "\|" \+ thumbprint \+ "\|" \+ orgID \+ "\|" \+ subjectID/);
  const sql = sqlCode(read(INC));
  assert.match(sql, /'work-device-cert-renew-v2\|' \|\| p_pairing_id::text \|\| '\|' \|\| p_challenge\s*\n\s*\|\| '\|' \|\| v_pairing\.public_key_thumbprint \|\| '\|' \|\| p_org_id \|\| '\|'\s*\n\s*\|\| p_actor_subject_id/);
  // The design names only the pairing domain, so this one is an implementation choice and
  // must be registered as such rather than presented as a design quotation.
  assert.match(read(RENEWAL_SIG), /the implementation's\s*\n\/\/ choice/);
});

test('a configured CA is loaded, validated, and never generated in process by work-api', () => {
  const load = goCode(read(LOAD));
  assert.match(load, /func LoadCA\(certPEM, keyPEM \[\]byte\) \(\*CA, error\)/);
  assert.match(load, /if !cert\.IsCA \|\| cert\.KeyUsage&x509\.KeyUsageCertSign == 0 \{/);
  assert.match(load, /if !time\.Now\(\)\.Before\(cert\.NotAfter\) \{/);
  assert.match(load, /if !publicKeysMatch\(signer\.Public\(\), cert\.PublicKey\) \{/);
  // 2026-11-22 custody seam: the match is made through the signer interface now, so the
  // loader no longer names a key type at all. Key parsing lives in signer.go, and doing it
  // again here would put two custody boundaries in the same package.
  assert.ok(!/ParsePKCS8PrivateKey|ParseECPrivateKey/.test(load),
    'load.go must not parse key material itself; signer.go is the custody boundary');
  const signerSrc = goCode(read(join(WORK, 'internal', 'deviceca', 'signer.go')));
  assert.match(signerSrc, /func fileSignerFromPEM\(keyPEM \[\]byte\) \(crypto\.Signer, error\)/);
  assert.match(signerSrc, /func publicKeysMatch\(a, b crypto\.PublicKey\) bool \{/);
  const caSrc = goCode(read(join(WORK, 'internal', 'deviceca', 'ca.go')));
  assert.match(caSrc, /Signer\s+crypto\.Signer/);
  assert.ok(!/Key\s+\*ecdsa\.PrivateKey/.test(caSrc),
    'the CA must not hold a concrete private key again; that field is the seam this batch made');
  assert.match(caSrc, /x509\.CreateCertificate\(rand\.Reader, template, c\.Cert, pub, c\.Signer\)/);
  // The one invariant the seam is allowed to have: issuing through the interface equals
  // issuing with a concrete key, field by field.
  assert.match(read(join(WORK, 'internal', 'deviceca', 'signer_test.go')),
    /func TestFileBackendSignsTheSameCertificateTemplate\(t \*testing\.T\) \{/);
  const main = goCode(read(MAIN));
  assert.match(main, /os\.Getenv\("WORK_DEVICE_CA"\)/);
  assert.match(main, /requiredEnv\("WORK_DEVICE_CA_KEY"\)/);
  assert.match(main, /deviceca\.LoadCA\(certPEM, keyPEM\)/);
  assert.match(main, /server\.SetDeviceCA\(deviceCA\)/);
  // work-api must not mint its own CA: that would be a test CA in production clothing.
  assert.ok(!main.includes('deviceca.NewCA('), 'work-api must load the configured CA, not generate one');
  assert.match(goCode(read(BOOTSTRAP)), /func \(s \*Server\) SetDeviceCA\(ca \*deviceca\.CA\)/);
  // The template declares paths only, commented out; key material never lives in a template.
  const env = read(ENV);
  assert.match(env, /^#WORK_DEVICE_CA=\/etc\/work\/device-ca\.pem$/m);
  assert.match(env, /^#WORK_DEVICE_CA_KEY=\/etc\/work\/device-ca\.key$/m);
  assert.ok(!/BEGIN [A-Z ]*PRIVATE KEY/.test(env), 'the env template must not carry key material');
  assert.match(env, /J39 sign-off item and are NOT settled by wiring these two variables/);
  // Access control is the deployment's job (2026-11-22 ruling: plain file key plane, ACL
  // deployment-side, no process-side mode check), so the shape has to be written down.
  assert.match(env, /0600 and root-owned/);
  assert.match(env, /performs no mode check of its own/);
});

test('the new evidence runs in CI: no platform or environment skip on the certificate tests', () => {
  const files = [
    join(API, 'device_certificate_test.go'),
    join(WORK, 'internal', 'migrate', 'r0b_device_certificate_test.go'),
    join(WORK, 'internal', 'deviceca', 'load_test.go'),
    join(WORK, 'internal', 'devicesig', 'certrenewal_test.go'),
  ];
  for (const p of files) {
    assert.ok(existsSync(p), `missing ${p}`);
    const src = read(p);
    assert.ok(!/t\.Skip/.test(src), `${p} skips, so a green suite would prove nothing about GW20`);
    assert.ok(!/runtime\.GOOS/.test(src), `${p} is platform-gated; GW20 is Go+PG and CI covers it fully`);
  }
  // Unlike GW18/GW19a this seam IS CI-coverable, so no workflow may claim otherwise.
  const workflows = join(ROOT, '.github', 'workflows');
  for (const f of readdirSync(workflows).filter((n) => /\.ya?ml$/.test(n))) {
    const src = read(join(workflows, f));
    assert.ok(!/WORK_DEVICE_CA_KEY=.*BEGIN/.test(src), `${f} must not inline a CA key`);
  }
});

test('the API evidence asserts the certificate itself, not only a non-null field', () => {
  const src = read(join(API, 'device_certificate_test.go'));
  assert.match(src, /leaf\.CheckSignatureFrom\(issuer\)/);
  assert.match(src, /leaf\.Subject\.CommonName != deviceID/);
  assert.match(src, /leaf\.Subject\.OrganizationalUnit\[0\] != testOrg/);
  assert.match(src, /x509\.ExtKeyUsageClientAuth/);
  assert.match(src, /deviceTestPrivateKey\(\)\.Public\(\)/);
  assert.match(src, /replay\["certificate_pem"\] != response\["certificate_pem"\]/);
  assert.match(src, /action='device\.cert\.recorded'/);
  // The fail-closed test must prove ZERO rows moved, not only a 503.
  assert.match(src, /status != "pending" \|\| serial != nil/);
  assert.match(src, /pairingState != "pending"/);
  // Domain separation is proven with a real pairing-domain signature over the renewal challenge.
  assert.match(src, /signDevicePairing\(t, renewPairing, renewChallenge\)/);
  assert.match(src, /signDeviceRenewal\(t, renewPairing, renewChallenge\)/);
});