// 2026-11-18 (GW19a). The production device identity is a NON-EXPORTABLE CNG key, and until
// this batch the only way the shipped link could present a client certificate was a PKCS#12
// archive — which needs the private scalar. That contradiction was registered in tls.rs and
// deferred to J39. This gate pins the resolution and, more importantly, the MEASURED platform
// facts that make it work, each of which is one plausible "simplification" away from breaking:
//   - CERT_KEY_PROV_INFO_PROP_ID must leave dwKeySpec at 0; AT_SIGNATURE/AT_KEYEXCHANGE send
//     crypt32 down the legacy CSP path (NTE_KEYSET_NOT_DEF) even though the key opens by name;
//   - CERT_NCRYPT_KEY_HANDLE_PROP_ID is not an alternative (CRYPT_E_NO_DECRYPT_CERT);
//   - schannel's `connect` does I/O immediately, so it must be deferred into a poll context or
//     the AllowStd waker is null and the process panics;
//   - the TLS 1.3 floor is only provable from the SERVER side: a 1.2-only peer that also offers
//     h2 makes a broken floor complete a handshake, which the probe's own error cannot distinguish.
//
// Deliberately NOT asserted: that a certificate is ever issued in production. It is not —
// confirm_device_pairing returns certificate_pem:null and cert_serial has no writer, so the
// renewal face is permanently refused. That gap is registered, not closed here.
// 【2026-11-18 GW20 更正：上面这句自 GW20 起不再成立。0058 落了 record_device_certificate
// （cert_serial/cert_not_after 的第一个写入者）与 confirm_device_certificate_renewal
// （purpose='renew' 的第一个消费者），work-api 从配置注入 CA 并在 confirm 提交后事务外签发、
// 第二次调用回填，响应不再恒 null；续期面也不再恒拒。0046 的 confirm 命令本身仍返回 null 三元组
// （CA 在事务外签名），变的是 Go 层随后把它填上。本文件下方那条断言已按此改写，原文保留以存其旧。】
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(HERE, '..', '..', '..', '..', '..');
const DEVICE = join(ROOT, 'src', 'device');
const GATEWAY = join(ROOT, 'src', 'work', 'internal', 'gateway');
const WORKFLOWS = join(ROOT, '.github', 'workflows');
const read = (p) => readFileSync(p, 'utf8');
// Rust has no '#' comment; stripping '#' lines would delete every #[cfg(...)] attribute.
const code = (t) => t.split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join('\n');
const prod = (t) => code(t.split('#[cfg(test)]')[0]);

const MOD = join(DEVICE, 'src', 'transport', 'mod.rs');
const LINK = join(DEVICE, 'src', 'transport', 'link.rs');
const TLS = join(DEVICE, 'src', 'transport', 'tls.rs');
const SCHANNEL = join(DEVICE, 'src', 'transport', 'schannel.rs');
const CNG = join(DEVICE, 'src', 'cng.rs');
const PROBE = join(DEVICE, 'examples', 'device_cng_probe.rs');
const INTEROP = join(GATEWAY, 'interop_cng_test.go');

for (const p of [MOD, LINK, TLS, SCHANNEL, CNG, PROBE, INTEROP]) {
  assert.ok(existsSync(p), `missing ${p}`);
}

test('the client identity is a closed two-shape enum, not a PKCS#12 field', () => {
  const src = prod(read(MOD));
  assert.match(src, /pub enum ClientIdentity \{/);
  assert.match(src, /Pkcs12 \{ der: Vec<u8>, password: String \}/);
  assert.match(src, /CngBound \{/);
  for (const field of ['cert_der_chain: Vec<Vec<u8>>', 'container: String', 'provider: String']) {
    assert.ok(src.includes(field), `CngBound lost ${field}`);
  }
  assert.match(src, /pub identity: ClientIdentity,/);
  // The exportable shape must not remain a field a production caller could fill in.
  assert.ok(!src.includes('pub client_pkcs12'), 'LinkConfig still carries a PKCS#12 field');
  assert.ok(!src.includes('pub pkcs12_password'), 'LinkConfig still carries a PKCS#12 password');
  // The trust anchor is shared by both shapes and stays.
  assert.match(src, /pub ca_pem: Vec<u8>,/);
});

test('the link chooses the connector from the identity and refuses CNG off Windows', () => {
  const src = prod(read(LINK));
  const start = src.indexOf('async fn establish(');
  const end = src.indexOf('fn hello_envelope(', start);
  assert.ok(start >= 0 && end > start, 'establish is no longer a distinct function');
  const body = src.slice(start, end);
  assert.match(body, /match &config\.identity \{/);
  assert.match(body, /ClientIdentity::Pkcs12 \{ der, password \}/);
  assert.match(body, /DeviceTlsConnector::new\(&config\.ca_pem, der, password, &config\.server_name\)/);
  assert.match(body, /#\[cfg\(windows\)\]\s*\n\s*ClientIdentity::CngBound \{/);
  assert.match(body, /schannel::CngTlsConnector::new\(/);
  // A CNG identity on a non-Windows build must be an explicit refusal, not a silent fallback
  // to the exportable path.
  assert.match(body, /#\[cfg\(not\(windows\)\)\]\s*\n\s*ClientIdentity::CngBound \{ \.\. \}/);
  assert.match(body, /a CNG-bound identity requires Windows/);
  // GW17's ordering invariant survives the refactor: hello queued before streaming is awaited.
  const hello = body.indexOf('hello_envelope(config, key, ticket)');
  const send = body.indexOf('.send(Bytes::from(raw))');
  const ready = body.indexOf('grpc.ready()');
  const streaming = body.indexOf('.streaming(');
  assert.ok(hello >= 0 && send > hello && ready > send && streaming > ready,
    'establish must still build → queue the hello → ready() → streaming');
});

test('the certificate is bound to the CNG container with dwKeySpec left at zero', () => {
  const src = prod(read(SCHANNEL));
  // The leaf enters an identity STORE as DER, so schannel can build the chain; the CA enters
  // a separate trust store from PEM. Neither path ever sees a private scalar.
  assert.match(src, /add_encoded_certificate\(leaf_der\)/);
  assert.match(src, /CertContext::from_pem\(ca_pem\)/);
  const at = src.indexOf('set_key_prov_info()');
  assert.ok(at > 0, 'the connector no longer binds the certificate to a key provider');
  const binding = src.slice(at, src.indexOf(';', at));
  assert.match(binding, /\.container\(container\)/);
  assert.match(binding, /\.provider\(provider\)/);
  assert.match(binding, /\.silent\(true\)/);
  // THE measured requirement: any legacy AT_* key spec sends crypt32 to the CSP path.
  assert.ok(!binding.includes('key_spec'),
    'setting key_spec breaks CNG acquisition with NTE_KEYSET_NOT_DEF');
  // The measured reasons stay written down so nobody "simplifies" them back.
  const text = read(SCHANNEL);
  for (const fact of ['NTE_KEYSET_NOT_DEF', 'CRYPT_E_NO_DECRYPT_CERT', 'CertCreateSelfSignCertificate', 'dwKeySpec']) {
    assert.ok(text.includes(fact), `the measured fact ${fact} is no longer recorded`);
  }
});

test('the connector pins TLS 1.3, requests h2 and verifies what was negotiated', () => {
  const src = prod(read(SCHANNEL));
  assert.match(src, /enabled_protocols\(&\[Protocol::Tls13\]\)/);
  assert.ok(!/Protocol::Tls12/.test(src), 'the production connector must not enable TLS 1.2');
  assert.match(src, /const ALPN_H2: &\[u8\] = b"h2"/);
  assert.match(src, /request_application_protocols\(&\[ALPN_H2\]\)/);
  assert.match(src, /negotiated_application_protocol\(\)/);
  assert.match(src, /want h2/);
  // The trust store is separate from the identity store: one validates the server, the other
  // carries the client chain.
  assert.match(src, /cert_store\(trust\)/);
  assert.match(src, /domain\(&server_name\)/);
});

test('the first connect is deferred into a poll context, never called from the async block', () => {
  const src = prod(read(SCHANNEL));
  // schannel performs I/O inside connect(), so AllowStd must already hold a waker. Calling it
  // from the connector's async block panicked with "assertion failed: !self.context.is_null()".
  assert.match(src, /type ConnectFn =/);
  assert.match(src, /^\s*Start\(Option<\(AllowStd, ConnectFn\)>\),/m);
  // connect is called with the CLOSURE PARAMETER, which only exists inside the deferred
  // closure; and the stream is handed over in Start, never pre-established in Ready.
  assert.match(src, /builder\.connect\(cred, allow\)/);
  assert.match(src, /let connect: ConnectFn = Box::new\(move \|allow\| \{/);
  const call = src.slice(src.indexOf('fn call(&mut self, uri: Uri)'));
  assert.match(call, /State::Start\(Some\(\(/);
  assert.ok(!call.includes('State::Ready('),
    'the connector must not hand over an already-established stream');
  assert.match(src, /allow\.context = ctx as \*mut _ as \*mut \(\);/);
  assert.match(src, /connect\(allow\)/);
  // The WouldBlock contract is what makes the adapter legal; it must stay stated.
  assert.match(read(SCHANNEL), /WouldBlock/);
  assert.match(src, /Poll::Pending => Err\(io::Error::from\(io::ErrorKind::WouldBlock\)\)/);
});

test('empty key material is refused before the platform certificate APIs are called', () => {
  const src = prod(read(SCHANNEL));
  const guard = src.indexOf('ca_pem.is_empty() || cert_der_chain.is_empty() || container.is_empty()');
  assert.ok(guard > 0, 'the empty-material guard is gone');
  assert.ok(guard < src.indexOf('Memory::new()'), 'the guard must precede the platform call');
  assert.match(src, /leaf_der\.is_empty\(\)/);
});

test('the CNG key is shareable across async tasks and still non-exportable', () => {
  const src = prod(read(CNG));
  assert.match(src, /unsafe impl Send for CngKey \{\}/);
  assert.match(src, /unsafe impl Sync for CngKey \{\}/);
  // The justification must stay: without it the link cannot hold the production key at all.
  assert.match(read(CNG), /Arc<dyn DeviceKey \+ Send \+ Sync>/);
  // Export policy 0 is the whole point of §2.1 and must not be relaxed to make TLS easier.
  assert.match(src, /let policy = 0u32\.to_le_bytes\(\)/);
  assert.match(src, /w!\("Export Policy"\)/);
});

test('the probe structurally cannot dial with exported key material', () => {
  const text = read(PROBE);
  const src = prod(text);
  const cfg = src.slice(src.indexOf('struct DialConfig'), src.indexOf('fn fail('));
  for (const forbidden of ['device_key_scalar_hex', 'client_pkcs12', 'pkcs12_password', 'scalar']) {
    assert.ok(!cfg.includes(forbidden), `the dial config carries ${forbidden}`);
  }
  for (const field of ['cert_der_chain_base64', 'container', 'provider', 'ticket']) {
    assert.ok(cfg.includes(field), `the dial config lost ${field}`);
  }
  // The SAME CNG key signs the hello: no second software key is loaded.
  assert.match(src, /CngKey::open\(&cfg\.container\)/);
  assert.match(src, /Link::new\(config, Arc::new\(key\)\)/);
  assert.ok(!src.includes('SoftwareKey'), 'the probe must not fall back to an exportable key');
  assert.match(src, /identity: ClientIdentity::CngBound \{/);
  // Three phases, and the key is a real user-profile artifact that must be cleaned up.
  for (const mode of ['Some("keygen")', 'Some("dial")', 'Some("delete")']) {
    assert.ok(src.includes(mode), `the probe lost the ${mode} phase`);
  }
  assert.match(src, /CNG_KEYGEN /);
  assert.match(src, /PROBE_REPORT /);
  assert.match(src, /#\[cfg\(not\(windows\)\)\]/);
  // Not a production artifact.
  assert.ok(!read(join(DEVICE, 'src', 'main.rs')).includes('device_cng_probe'));
  assert.ok(!read(join(DEVICE, 'Cargo.toml')).includes('device_cng_probe'));
  assert.ok(!existsSync(join(DEVICE, 'cmd', 'device_cng_probe')));
});

test('the Go orchestration issues for the CNG public key and asserts server-side truth', () => {
  const go = read(INTEROP);
  assert.match(go, /cngBinEnv = "WORK_DEVICE_CNG_BIN"/);
  assert.match(go, /runtime\.GOOS != "windows"/);
  assert.match(go, /t\.Skipf\(/);
  assert.match(go, /os\.Stat\(bin\)/);
  // Two processes: the CA cannot sign for a key it has never seen, and the split also proves
  // the persisted key survives a restart.
  assert.match(go, /runCngProbe\(t, bin, "keygen", container\)/);
  assert.match(go, /runCngProbe\(t, bin, "dial", configPath\)/);
  assert.match(go, /runCngProbe\(t, bin, "delete", container\)/);
  assert.match(go, /devicesig\.ParseJWK\(jwkJSON\)/);
  assert.match(go, /f\.ca\.IssueDeviceCert\(f\.deviceID, gwOrg, pub\.Key\)/);
  // The device row is seeded with the CNG key, so the certificate and the hello signature are
  // one identity (§2.1) — not a Go software key standing in for it.
  assert.match(go, /newCngGatewayFixture\(t, jwkJSON, thumbprint\)/);
  assert.match(go, /jwkThumbprint\(t, report\["device_public_jwk"\]\); got != thumbprint/);
  for (const needle of ['work.device_session', 'work.device_session_ticket', 'consumed', 'alive_ms', 'cng_bound']) {
    assert.ok(go.includes(needle), `the interop no longer asserts ${needle}`);
  }
  // The real mint shape, not a placeholder ticket.
  assert.match(go, /ticket := sha256Hex\(uuid\.NewString\(\) \+ uuid\.NewString\(\)\)/);
  for (const forbidden of ['device_key_scalar_hex', 'client_pkcs12_base64', 'pkcs12_password']) {
    assert.ok(go.includes(`"${forbidden}"`), `the config guard no longer names ${forbidden}`);
  }
});

test('the TLS floor is proven from the server side, with h2 offered to remove the confound', () => {
  const go = read(INTEROP);
  const at = go.indexOf('func TestDeviceCngIdentityPinsTls13(');
  assert.ok(at > 0, 'the protocol-floor test is gone');
  const body = go.slice(at);
  assert.match(body, /MaxVersion:\s*tls\.VersionTLS12/);
  // Without NextProtos a broken floor could be masked by an ALPN failure: measured, the probe
  // still failed and the test still passed. Offering h2 makes a wrong floor complete a handshake.
  assert.match(body, /NextProtos:\s*\[\]string\{"h2"\}/);
  assert.match(body, /handshakes := make\(chan uint16/);
  assert.match(body, /if err := tlsConn\.Handshake\(\); err == nil \{/);
  assert.match(body, /handshakes <- tlsConn\.ConnectionState\(\)\.Version/);
  assert.match(body, /the device completed a TLS handshake with a 1\.2-only peer/);
  // The probe's own error string is NOT the discriminator; it is only a sanity check.
  assert.match(body, /strings\.Contains\(reason, "disconnected"\)/);
});

test('no CI workflow may claim the Windows CNG seam', () => {
  // Named pipes/CNG are Windows-only while the real PostgreSQL fixture lives in the Linux
  // go-migrate job, and GitHub Actions services are Linux-only. No job can span this seam, so
  // a workflow naming it would be claiming evidence it cannot produce.
  for (const file of readdirSync(WORKFLOWS).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))) {
    const text = read(join(WORKFLOWS, file));
    assert.ok(!text.includes('WORK_DEVICE_CNG_BIN'), `${file} claims the CNG interop`);
    assert.ok(!text.includes('device_cng_probe'), `${file} builds the CNG probe`);
  }
});

test('the GW17 exportable test path is intact and still labelled test-only', () => {
  const tls = read(TLS);
  const src = code(tls);
  // The enum added a production shape; it must not have deleted the Linux interop's path.
  assert.match(src, /Identity::from_pkcs12\(client_pkcs12, pkcs12_password\)/);
  assert.ok(!src.includes('from_pkcs8'), 'schannel from_pkcs8 is RSA-only');
  assert.match(src, /request_alpns\(ALPN_H2\)/);
  assert.match(tls, /rsa_full/);
  // Both registered boundaries stay written down: the PKCS#12 one is now resolved on Windows
  // by schannel.rs, but the native-tls path still cannot pin a protocol floor.
  assert.match(tls, /NON-EXPORTABLE|non-exportable/);
  assert.match(tls, /minimum-protocol-version|TLS 1\.3 floor/);
});

test('GW19a added no migration; the issuance chain it left open is closed by 0058', () => {
  const increments = join(ROOT, 'src', 'work', 'migrations', 'increments');
  const files = readdirSync(increments).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
  // GW19a's own claim was "no migration in this batch". GW20 legitimately adds 0058, so
  // the durable invariant is that every increment on disk is registered, not a frozen tip.
  assert.ok(files.includes('0057_cancellation_intent_consumer.sql'), 'GW19a landed on top of 0057');
  const manifest = JSON.parse(read(join(ROOT, 'src', 'work', 'migrations', 'manifest.json')));
  const registered = manifest.increments.map((m) => m.file.split('/').at(-1));
  assert.deepEqual(files, registered, 'every increment on disk must be registered in manifest order');
  // 0046 is deliberately untouched: the pairing confirm COMMAND still returns the null
  // triple, because the CA signs outside the transaction. What changed in GW20 is that a
  // second call (record_device_certificate) now fills it, so the response is no longer null.
  const confirm = read(join(increments, '0046_device_pairing_signature_verify.sql'));
  assert.match(confirm, /'cert_serial', null, 'cert_not_after', null, 'certificate_pem', null/);
  const issuance = read(join(increments, '0058_device_certificate_issuance.sql'));
  assert.match(issuance, /CREATE FUNCTION work\.record_device_certificate\(/);
});