// 2026-11-18 (GW21). GW18/GW19a proved their seams with test-only examples because the crate had
// NO executable Broker entry: main.rs printed a version. GW21 landed the real process and the whole
// §2.1 Broker side (identity report, two purpose-specific signing methods, certificate import,
// read-only renewal status), so this guard pins the entry, the import gates and the five rulings it
// was built under:
//   ① scope = the executable entry + the §2.1 Broker-side landing points. REST stays with the
//     desktop main process, so this binary must have NO HTTP client;
//   ② config = one closed JSON file in the per-user install directory, no arbitrary path/url field;
//   ③ certificate storage = in memory (the GW19a shape). No disk artefact, so a restart needs the
//     shell to re-deliver; shell-side persistence is M2 and is NOT claimed here;
//   ④ signing = two purpose-specific methods, each building its own preimage from closed fields, so
//     the shell can never make the Broker sign arbitrary bytes;
//   ⑤ renewal notification = a read-only status method the shell polls. No server-initiated push.
//
// Deliberately NOT asserted: A2 downlink consumption, A3 uplink production, a Node executor, and
// shell-side ticket minting or certificate persistence. The entry logs downlinks and consumes
// nothing, and a gate demanding consumption would be demanding unruled scope.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(HERE, '..', '..', '..', '..', '..');
const DEVICE = join(ROOT, 'src', 'device');
const WORKFLOWS = join(ROOT, '.github', 'workflows');
const read = (p) => readFileSync(p, 'utf8');
// Comments state intent; only code lines may satisfy a structural assertion. Rust has no '#'
// comment, and stripping '#' lines would delete every #[cfg(...)] attribute — which is exactly
// what the platform-boundary assertions below need to see.
const code = (t) => t.split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join('\n');
// The production half of a Rust file: a test module may legitimately import anything.
const prod = (t) => code(t.split('#[cfg(test)]')[0]);

const MAIN = join(DEVICE, 'src', 'main.rs');
const IDENTITY = join(DEVICE, 'src', 'identity.rs');
const RENEWAL = join(DEVICE, 'src', 'certrenewal.rs');
const PAIRING = join(DEVICE, 'src', 'pairing.rs');
const BROKER = join(DEVICE, 'src', 'broker.rs');
const DISPATCH = join(DEVICE, 'src', 'ipc', 'dispatch.rs');
const SCHEMA = join(DEVICE, 'src', 'ipc', 'schema.rs');
const PIPE = join(DEVICE, 'src', 'ipc', 'pipe.rs');
const LINK = join(DEVICE, 'src', 'transport', 'link.rs');
const TRANSPORT = join(DEVICE, 'src', 'transport', 'mod.rs');
const LIB = join(DEVICE, 'src', 'lib.rs');
const INTEROP = join(ROOT, 'src', 'work', 'internal', 'api', 'device_broker_interop_test.go');

for (const p of [MAIN, IDENTITY, RENEWAL, PAIRING, BROKER, DISPATCH, SCHEMA, PIPE, LINK, TRANSPORT,
  LIB, INTEROP]) {
  assert.ok(existsSync(p), `missing ${p}`);
}

// A function body runs from its signature to the closing brace at the SAME indentation, so a test
// inside `mod tests` is delimited by its own brace and not by the module's.
const fnBody = (src, signature) => {
  const start = src.indexOf(signature);
  assert.ok(start >= 0, `${signature} is gone`);
  const lineStart = src.lastIndexOf('\n', start) + 1;
  const indent = /^\s*/.exec(src.slice(lineStart, start))[0];
  const end = src.indexOf(`\n${indent}}`, start);
  assert.ok(end > start, `cannot delimit ${signature}`);
  return src.slice(start, end);
};

test('the entry is a real process with a closed config and no HTTP client', () => {
  const src = code(read(MAIN));
  // Ruling ②: one closed shape. An unknown key is a parse failure, not an ignored extra.
  assert.match(src, /#\[serde\(deny_unknown_fields\)\]/);
  const config = src.slice(src.indexOf('struct BrokerConfig'), src.indexOf('\n}', src.indexOf('struct BrokerConfig')));
  for (const field of ['pipe_name', 'endpoint', 'server_name', 'ca_pem_path', 'container',
    'provider', 'boot_id', 'agent_instance_id', 'journal_epoch', 'profile_id',
    'tool_manifest_hash', 'runtime_digest', 'last_receipt_seq', 'connect_timeout_ms',
    'reconnect_base_ms', 'reconnect_max_ms']) {
    assert.match(config, new RegExp(`^\\s*${field}: `, 'm'), `${field} left the closed config`);
  }
  // The only path the config names is the CA anchor, read once at startup. Ruling ③ keeps the
  // certificate itself in memory, so there is no certificate path to widen the attack surface.
  assert.equal(config.split('_path:').length - 1, 1, 'the config grew a second path field');
  assert.ok(!/cert(ificate)?_path/.test(config), 'the config persists the certificate, which ruling ③ forbids');
  // Ruling ①: REST belongs to the desktop main process. This binary signs and reports, it never calls.
  for (const forbidden of ['reqwest', 'hyper', 'ureq', 'http::', 'https://', '/devices/', 'POST']) {
    assert.ok(!src.includes(forbidden), `the Broker entry reached for ${forbidden}; REST is the shell's`);
  }
  // The blocking pipe loop stays off the async runtime, and the pump owns the identity.
  assert.match(src, /std::thread::spawn\(move \|\| \{\s*\n\s*work_device::ipc::service::serve_shell_pipe\(&pipe_name, delivery_tx\)/);
  assert.match(src, /run_core_pump\(\s*\n\s*identity,\s*\n\s*TicketSlot::new\(""\)/);
  // The slot starts empty because the device id is only knowable from a CA-signed CN.
  assert.match(read(MAIN), /keyed by an empty string/);
});

test('the link waits for a certificate and a renewal replaces the identity, not the session', () => {
  const src = code(read(MAIN));
  const run = fnBody(src, 'fn run(path: &str)');
  const wait = run.indexOf('ready_rx.recv().await');
  const spawn = run.indexOf('spawn_link(&cfg');
  assert.ok(wait >= 0 && spawn > wait, 'the link is built before any certificate-backed identity exists');
  // ClientIdentity has no identity-less variant, so there is nothing to dial with beforehand.
  assert.match(run, /the core pump stopped before any certificate was delivered/);
  // A renewal cannot rebuild the link: the pump's channel ends are fixed for its lifetime.
  assert.match(run, /LinkCommand::ReplaceIdentity\(ready\.identity\)/);
  assert.ok(!run.includes('Link::new'), 'the entry rebuilds the link on renewal instead of replacing the identity');
  assert.match(read(TRANSPORT), /ReplaceIdentity\(ClientIdentity\)/);
  const link = code(read(LINK));
  // Both command-read sites must ASSIGN the new identity. Counting the variant name alone would
  // let one site swallow it (`ReplaceIdentity(_) => {}`) and still look wired (measured).
  assert.equal(link.split('LinkCommand::ReplaceIdentity(identity)) => { self.config.identity = identity; }').length - 1, 2,
    'both command-read sites must honour the replacement, or a renewal is lost at one of them');
  // The pump publishes only after a delivery actually held a certificate.
  const broker = code(read(BROKER));
  const publish = broker.slice(broker.indexOf('if let (Some(device_id), Ok(link_identity))'), broker.indexOf('if awaiting {'));
  assert.match(publish, /Some\("deliverDeviceCertificate"\)/);
  assert.match(publish, /ready\s*\n?\s*\.send\(ReadyIdentity/);
});

test('a non-Windows build refuses to start rather than substituting an exportable key', () => {
  const src = read(MAIN);
  const refusal = src.slice(src.indexOf('#[cfg(not(windows))]\nfn open_or_create_key'));
  assert.match(refusal, /Err\(\s*\n?\s*"the Broker's production identity is a Windows CNG key/);
  assert.ok(!prod(src).includes('SoftwareKey'), 'the entry falls back to an exportable software key');
  // The provider comes from the config, so naming a TPM provider cannot silently become software CNG.
  const windows = src.slice(src.indexOf('#[cfg(windows)]\nfn open_or_create_key'), src.indexOf('#[cfg(not(windows))]\nfn open_or_create_key'));
  assert.match(windows, /CngKey::open\(container\)/);
  assert.match(windows, /CngKey::create\(container\)/);
  // A persisted CNG container is a real user-profile artefact: teardown is an explicit operation.
  assert.match(src, /Some\("--delete-container"\)/);
  assert.match(src, /fn delete_container\(name: &str\)/);
  assert.match(src, /key\.delete\(\)/);
  // The identity itself refuses a non-Windows link identity even if a certificate were held.
  const identity = code(read(IDENTITY));
  const linkIdentity = fnBody(identity, 'pub fn link_identity(');
  assert.match(linkIdentity, /if !cfg!\(windows\) \{\s*\n\s*return Err\(IdentityError::NotWindows\)/);
  assert.match(linkIdentity, /ClientIdentity::CngBound/);
  assert.ok(!linkIdentity.includes('Pkcs12'), 'the link identity offers an exportable variant');
});

test('every certificate gate runs before anything is stored, in the order the design names', () => {
  const src = code(read(IDENTITY));
  const deliver = fnBody(src, 'pub fn deliver_certificate(');
  // A certificate before any signing has no org to bind against: that is a distinct closed code,
  // so the shell knows to pair first rather than retry the same bytes.
  const noPairing = deliver.indexOf('IdentityError::NoPairing');
  const validate = deliver.indexOf('validate_chain(');
  const store = deliver.indexOf('self.held = Some(held)');
  assert.ok(noPairing >= 0 && validate > noPairing && store > validate,
    'the certificate is stored before it is validated, or validated before the org is known');
  assert.match(deliver, /self\.device_id = Some\(device_id\.to_string\(\)\)/);
  // The org is remembered only after a SUCCESSFUL signature.
  const signFor = fnBody(src, 'fn sign_for(');
  const signAt = signFor.indexOf('let signature = sign(');
  const rememberAt = signFor.indexOf('self.signed_org = Some(');
  assert.ok(signAt >= 0 && rememberAt > signAt, 'a refused signing request leaves an org behind');

  const chain = fnBody(src, 'fn validate_chain(');
  const gates = [
    ['CA signature', 'CryptVerifyCertificateSignature(None, X509_ASN_ENCODING, &der_chain[0], issuer_key)'],
    ['CN', 'if cn != device_id'],
    ['OU', 'if ou != org_id'],
    ['public key', 'if public_key != point'],
    ['clientAuth EKU', 'if !client_auth_ok(leaf)?'],
    ['expiry', 'if not_after <= SystemTime::now()'],
  ];
  let previous = -1;
  for (const [name, needle] of gates) {
    const at = chain.indexOf(needle);
    assert.ok(at > previous, `the ${name} gate is gone or out of order`);
    previous = at;
    assert.match(chain.slice(at, at + 220), /IdentityError::CertificateInvalid/,
      `the ${name} gate does not refuse with the closed code`);
  }
  // The issuer key comes from the CA's own CERT_INFO. CryptVerifyCertificateSignatureEx's
  // subject/issuer-type constants produced an ASN1 end-of-data error on a valid chain (measured).
  assert.ok(!chain.includes('CryptVerifyCertificateSignatureEx'), 'the unreliable Ex variant is back');
  assert.match(chain, /&\(\*info\)\.SubjectPublicKeyInfo as \*const _/);
  // The gates run inside a closure so BOTH contexts are freed on every refusal path, not only on
  // success; the one earlier free is the CA-parse refusal, where only the leaf exists yet.
  const closureEnd = chain.indexOf('})();');
  const freeLeaf = chain.indexOf('CertFreeCertificateContext(Some(leaf))', closureEnd);
  const freeCa = chain.indexOf('CertFreeCertificateContext(Some(ca))', closureEnd);
  assert.ok(closureEnd > previous && freeLeaf > closureEnd && freeCa > freeLeaf,
    'a gate refusal leaks a certificate context');
  assert.match(chain.slice(freeCa), /\}\s*\n\s*result/);
  assert.equal(chain.split('CertFreeCertificateContext(Some(').length - 1, 3);
  assert.match(chain, /if ca\.is_null\(\) \{\s*\n\s*unsafe \{\s*\n\s*let _ = CertFreeCertificateContext\(Some\(leaf\)\)/);
  // The public-key comparison is exact: the SPKI BIT STRING content IS the uncompressed point.
  assert.match(chain, /blob\.cUnusedBits != 0/);
  assert.match(chain, /jwk\.to_encoded_point\(\)/);
});

test('NotAfter and the serial are read as the values the server recorded', () => {
  const src = read(IDENTITY);
  // A dropped zero in the FILETIME epoch offset still yields a plausible date — 332 years out —
  // so the renewal window would never open. The constant is pinned, and so is the absolute
  // comparison that discriminates it (measured: the interop read 2358-12-26 for a 24h leaf).
  assert.match(src, /const EPOCH_OFFSET_100NS: u64 = 116_444_736_000_000_000;/);
  assert.match(src, /\(\(ft\.dwHighDateTime as u64\) << 32\) \| ft\.dwLowDateTime as u64/);
  assert.match(src, /UNIX_EPOCH \+ Duration::from_nanos\(unix_100ns \* 100\)/);
  assert.match(src, /fn filetime_reads_the_leaf_not_after_as_the_instant_it_encodes/);
  const pinned = fnBody(src, 'fn filetime_reads_the_leaf_not_after_as_the_instant_it_encodes(');
  assert.match(pinned, /\(1_800_000_000 \+ 11_644_473_600\) \* 10_000_000/);
  assert.match(pinned, /UNIX_EPOCH \+ Duration::from_secs\(1_800_000_000\)/);
  // CRYPT_INTEGER_BLOB is little-endian and the serial is a random 128-bit integer, so it fits no
  // native type: the decimal conversion is by repeated division, not a cast.
  const chain = code(src).slice(code(src).indexOf('fn validate_chain('));
  assert.match(chain, /be\.reverse\(\)/);
  assert.match(chain, /decimal_from_be\(&be\)/);
  assert.ok(!/SerialNumber.*as u64/.test(chain), 'the serial is cast into a native integer');
  assert.match(src, /fn decimal_conversion_matches_known_values/);
  // The window is the last hour, and an already-expired certificate is also "open".
  assert.match(src, /pub const RENEWAL_WINDOW: Duration = Duration::from_secs\(3600\)/);
  const window = fnBody(code(src), 'pub fn renewal_window_open(');
  assert.match(window, /Ok\(remaining\) => remaining <= RENEWAL_WINDOW/);
  assert.match(window, /Err\(_\) => true/);
});

test('the certificate store is in memory and the PEM parser is strict', () => {
  const src = prod(read(IDENTITY));
  // Ruling ③: no disk artefact. A restart therefore needs the shell to re-deliver, which is M2.
  for (const forbidden of ['std::fs::write', 'File::create', 'OpenOptions', 'std::fs::remove']) {
    assert.ok(!src.includes(forbidden), `the identity writes to disk (${forbidden}); ruling ③ is in-memory`);
  }
  assert.match(read(IDENTITY), /in memory|in-memory/);
  // A truncated or non-base64 block is a refusal, not a skip: a short chain must not pass as a
  // shorter one, and the order is preserved because the link presents leaf first.
  const pem = fnBody(src, 'fn pem_certificates(');
  assert.match(pem, /body\.find\(END\)\.ok_or\(IdentityError::Shape\)\?/);
  assert.match(pem, /base64ct::Base64::decode_vec\(&encoded\)\.map_err\(\|_\| IdentityError::Shape\)\?/);
  assert.match(pem, /if encoded\.is_empty\(\)/);
  assert.match(read(IDENTITY), /fn pem_parsing_is_strict_about_a_truncated_block/);
  assert.match(read(IDENTITY), /fn pem_parsing_keeps_chain_order/);
  // Empty material never reaches schannel: from_pem on zero-length input is a process crash.
  const ctor = fnBody(src, 'pub fn new(');
  assert.match(ctor, /config\.container\.is_empty\(\) \|\| config\.provider\.is_empty\(\)/);
  assert.match(ctor, /pem_certificates\(&config\.ca_pem\)\?/);
});

test('the two signing purposes build their own preimages under different domains', () => {
  const renewal = read(RENEWAL);
  const pairing = read(PAIRING);
  assert.match(renewal, /pub const RENEW_DOMAIN: &str = "work-device-cert-renew-v2";/);
  assert.match(pairing, /pub const PAIR_DOMAIN: &str = "work-device-pair-v2";/);
  assert.match(renewal, /format!\("\{RENEW_DOMAIN\}\|\{pairing_id\}\|\{challenge\}\|\{thumbprint\}\|\{org_id\}\|\{subject_id\}"\)/);
  // The thumbprint comes from the key, so it always matches the JWK the server holds.
  assert.match(renewal, /let thumbprint = key\.thumbprint\(\);/);
  // §2.1 names only the pairing domain; the renewal string is the implementation's choice and is
  // registered as such, matching Go devicesig/certrenewal.go and SQL 0058 byte for byte.
  assert.match(renewal, /The domain string is the implementation's choice, registered as such/);
  for (const name of ['a_pairing_signature_does_not_verify_as_a_renewal',
    'the_two_domains_are_not_the_same_string', 'signature_binds_every_field',
    'a_different_key_does_not_verify']) {
    assert.match(renewal, new RegExp(`fn ${name}\\(`), `${name} is gone`);
  }
  // Ruling ④: the shell supplies FIELDS, never bytes. The closed set is exactly the four names.
  const broker = code(read(BROKER));
  const handle = fnBody(broker, 'fn handle_message(');
  assert.match(handle, /"signDevicePairing" \| "signDeviceCertificateRenewal" => \{\s*\n\s*&\["pairing_id", "challenge", "org_id", "subject_id"\]/);
  assert.match(handle, /identity\.sign_pairing\(/);
  assert.match(handle, /identity\.sign_renewal\(/);
  for (const forbidden of ['preimage', 'covered', 'bytes_to_sign', 'payload']) {
    assert.ok(!handle.includes(forbidden), `the shell can hand the Broker a preimage (${forbidden})`);
  }
  const identity = code(read(IDENTITY));
  assert.match(fnBody(identity, 'pub fn sign_pairing('), /crate::pairing::sign/);
  assert.match(fnBody(identity, 'pub fn sign_renewal('), /crate::certrenewal::sign/);
  assert.match(read(LIB), /^pub mod certrenewal;/m);
  assert.match(read(LIB), /^pub mod identity;/m);
});

test('the status method is read-only and the reply payload is a closed shape', () => {
  const broker = code(read(BROKER));
  const handle = fnBody(broker, 'fn handle_message(');
  // Ruling ⑤: the shell polls. The status arm must not sign, import or withdraw anything.
  const status = handle.slice(handle.indexOf('"getDeviceCertificateStatus" => {'), handle.indexOf('_ => Reply::refused(message, "unknown_method")'));
  for (const forbidden of ['sign_pairing', 'sign_renewal', 'deliver_certificate', 'slot.take', 'withdraw']) {
    assert.ok(!status.includes(forbidden), `the read-only status arm calls ${forbidden}`);
  }
  for (const key of ['has_certificate', 'device_id', 'cert_serial', 'cert_not_after', 'renewal_window_open']) {
    assert.ok(status.includes(`"${key}"`), `the status reply lost ${key}`);
  }
  assert.match(status, /renewal_window_open\(std::time::SystemTime::now\(\)\)/);
  // An absent certificate reports null, not a fabricated serial or a zero date.
  assert.match(status, /unwrap_or\(Value::Null\)/);
  // The identity reply carries public material only. The arm is delimited from its own start,
  // because the same method names also appear earlier in the closed-field table.
  const identityStart = handle.indexOf('"getDeviceIdentity" => {');
  const identityArm = handle.slice(identityStart, handle.indexOf('"signDevicePairing" | "signDeviceCertificateRenewal" => {', identityStart));
  for (const key of ['public_key_jwk', 'public_key_thumbprint', 'container']) {
    assert.ok(identityArm.includes(`"${key}"`), `the identity reply lost ${key}`);
  }
  for (const forbidden of ['scalar', 'private', 'pkcs12', 'password']) {
    assert.ok(!identityArm.toLowerCase().includes(forbidden), `the identity reply leaks ${forbidden}`);
  }
  // The closed key set is exact: an unlisted key is a refusal, not something the handler ignores.
  const closed = fnBody(broker, 'fn closed_fields(');
  assert.match(closed, /object\.len\(\) != allowed\.len\(\)/);
  assert.match(closed, /object\.keys\(\)\.all\(\|k\| allowed\.contains\(&k\.as_str\(\)\)\)/);
  assert.match(closed, /Value::is_string/);
  // The slot is re-keyed on the first delivery, and a renewal must not reset the consumed set.
  const deliverArm = handle.slice(handle.indexOf('"deliverDeviceCertificate" => {'), handle.indexOf('"getDeviceCertificateStatus" => {'));
  assert.match(deliverArm, /if slot\.device_id\(\) != device_id \{\s*\n\s*\*slot = TicketSlot::new\(device_id\);/);
  // Accepted with a payload is four keys; the payload never appears on a refusal.
  const dispatch = read(DISPATCH);
  assert.match(dispatch, /pub data: Option<Value>/);
  assert.match(dispatch, /fn accepted_with\(/);
  assert.match(dispatch, /assert_eq!\(CODES\.len\(\), 9\)/);
  const schema = read(SCHEMA);
  for (const method of ['getDeviceIdentity', 'signDevicePairing', 'signDeviceCertificateRenewal',
    'deliverDeviceCertificate', 'getDeviceCertificateStatus']) {
    assert.ok(schema.includes(`"${method}"`), `${method} left the shell closure`);
  }
  assert.match(schema, /assert_eq!\(SHELL_METHODS\.len\(\), 19\)/);
  assert.match(dispatch, /assert_eq!\(CORE_METHODS\.len\(\), 6\)/);
});

test('a refusal reaches the shell before the pipe is disconnected', () => {
  const src = read(PIPE);
  const drop = src.slice(src.indexOf('impl Drop for PipeConnection'));
  const flush = drop.indexOf('FlushFileBuffers(self.handle)');
  const disconnect = drop.indexOf('DisconnectNamedPipe(self.handle)');
  assert.ok(flush >= 0 && disconnect > flush,
    'DisconnectNamedPipe discards the unread refusal, so the shell sees a broken pipe instead of the code');
  assert.match(src, /use windows::Win32::Storage::FileSystem::\{\s*\n\s*FlushFileBuffers/);
  // The reason is written down where the next reader will find it, not only in this gate.
  assert.match(src, /DisconnectNamedPipe discards whatever the client has not read yet/);
});

test('the platform seam is registered: no CI job claims the entry full chain', () => {
  const go = read(INTEROP);
  // A runtime skip, not a build tag: the go-test-surface gate forbids tags on _test.go files.
  assert.match(go, /runtime\.GOOS != "windows"/);
  assert.match(go, /t\.Skipf\(/);
  assert.ok(!/^\/\/go:build/m.test(go), 'the entry interop carries a build tag');
  const env = go.match(/brokerBinEnv = "([^"]+)"/);
  assert.ok(env, 'device_broker_interop_test.go no longer names its env constant');
  assert.equal(env[1], 'WORK_DEVICE_BIN');
  assert.match(go, /os\.Getenv\(brokerBinEnv\)/);
  assert.match(go, /os\.Stat\(bin\)/);
  for (const file of readdirSync(WORKFLOWS).filter((f) => f.endsWith('.yml'))) {
    const yaml = read(join(WORKFLOWS, file));
    assert.ok(!yaml.includes('WORK_DEVICE_BIN'),
      `${file} claims the entry seam; the pipe and CNG are Windows-only and the PG fixture is Linux-only`);
  }
  // The subject is the SHIPPED binary, not a test-only probe: that is what GW21 changed.
  assert.match(go, /the SHIPPED work-device binary, not a test-only probe/);
  assert.match(go, /exec\.Command\(bin, configPath\)/);
  assert.ok(!go.includes('device_broker_probe'), 'the entry interop drives a probe instead of the binary');
  // The persisted container is cleaned up, because it is a real user-profile artefact.
  assert.match(go, /"--delete-container", container/);
});

test('the interop drives the real REST face and asserts server-side truth', () => {
  const go = read(INTEROP);
  // The certificate comes out of work-api's confirm response, so the chain the Broker imports is
  // the one the server recorded. Only the last step's near-expiry leaf is minted by the fixture.
  assert.match(go, /api\.DevicePairingsPath/);
  assert.match(go, /api\.DevicePairingConfirmPath/);
  assert.match(go, /api\.DeviceSessionTicketsPath/);
  assert.match(go, /api\.DeviceCertificateRenewalsPath/);
  assert.match(go, /api\.DeviceCertificateRenewalConfirmPath/);
  assert.match(go, /confirmed\["certificate_pem"\]\.\(string\)/);
  assert.match(go, /the REST confirm issued no certificate/);
  // Go recomputes the thumbprint and verifies both signatures itself before submitting them.
  assert.match(go, /devicesig\.ParseJWK\(jwkRaw\)/);
  assert.match(go, /data\["public_key_thumbprint"\] != pub\.Thumbprint/);
  assert.match(go, /devicesig\.VerifyPairing\(pub, pairingID, challenge, testOrg, testSubject, signature\)/);
  assert.match(go, /devicesig\.VerifyCertRenewal\(pub, renewPairingID, renewChallenge, testOrg, testSubject, renewSignature\)/);
  // The domain-separation negative: a renewal signature must NOT verify under the pairing domain.
  assert.match(go, /if devicesig\.VerifyPairing\(pub, renewPairingID, renewChallenge, testOrg, testSubject, renewSignature\) \{/);
  // A foreign device id is refused because the CA-signed CN is authoritative, not the shell's claim.
  assert.match(go, /refused\["code"\] != "certificate_invalid"/);
  // Server-side truth, never inferred from the Broker's own report.
  for (const needle of ['work.device_session', 'work.device_session_ticket', 'consumed',
    'SELECT cert_serial FROM work.device', 'rowBoot != bootID', 'newSerial == certSerial']) {
    assert.ok(go.includes(needle), `the entry interop no longer asserts ${needle}`);
  }
  // The two windows have different authorities: moving the server row must not move the Broker.
  assert.match(go, /the Broker followed the server row instead of its own certificate/);
  assert.match(go, /setBrokerCertExpiry\(t, dbName, deviceID, "now\(\) \+ interval '30 minutes'"\)/);
  // The imported NotAfter is compared to the certificate that was actually issued.
  assert.match(go, /func certNotAfter\(t \*testing\.T, certPEM string\) string/);
  assert.match(go, /facts\["cert_not_after"\]; got != certNotAfter\(t, certPEM\)/);
  assert.match(go, /func shortLivedDeviceCert\(/);
  assert.match(go, /a certificate expiring in 30 minutes did not open the window/);
  // The gateway needs its own worker pool: the REST role may not SET ROLE work_worker.
  assert.match(go, /workdb\.OpenPool\(ctx, testpg\.WorkerURL\(dbName\), "work-gateway-broker-test"\)/);
});