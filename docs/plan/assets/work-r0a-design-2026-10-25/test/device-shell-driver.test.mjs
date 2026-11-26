// 2026-11-18 (M2a). The desktop shell's minimal Work device driver landed under six lead rulings
// (甲2 supervision+packaging / safeStorage certificate file / shell_pid enforcement this batch /
// Electron main-process dialog / 乙 identity endpoint / 甲 awaiting_ticket). GW21's gate pins the
// Broker side; THIS gate pins the shell side and the cross-language seams between them:
//   ① the REST face is a closed endpoint table in the MAIN process (Bearer plane), never a
//     renderer proxy — preload must not grow a Work surface;
//   ② the pipe client speaks the Broker's own framing/handshake/method/code closures — the two
//     sides are compared against the Rust source, not against a copied list;
//   ③ the config file the shell writes is field-for-field the Rust BrokerConfig (17 fields);
//   ④ the device-name gesture precedes ANY pairing request, and a cancel leaves zero rows;
//   ⑤ the certificate is persisted bound to account+service and re-delivered on every start
//     (the GW21 in-memory store × 0058 renewal-window restart deadlock is closed shell-side);
//   ⑥ minting happens ONLY while the pump reports awaiting_ticket; renewal ONLY in the window.
// Deliberately NOT asserted: A2/A3 consumption, a Node executor, production CA custody (J39),
// and any graceful Broker shutdown message (the closed set has no carrier; kill-only is registered).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(HERE, '..', '..', '..', '..', '..');
const DESKTOP = join(ROOT, 'src', 'desktop');
const DEVICE = join(ROOT, 'src', 'device');
const read = (p) => readFileSync(p, 'utf8');
const code = (t) => t.split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l) && !/^\s*\*/.test(l) && !/^\s*\/\*/.test(l)).join('\n');

const API = join(DESKTOP, 'src', 'work', 'api.ts');
const PIPE = join(DESKTOP, 'src', 'work', 'pipe.ts');
const STORE = join(DESKTOP, 'src', 'work', 'store.ts');
const BROKER = join(DESKTOP, 'src', 'work', 'broker.ts');
const DRIVER = join(DESKTOP, 'src', 'work', 'driver.ts');
const MAIN = join(DESKTOP, 'src', 'main.ts');
const PRELOAD = join(DESKTOP, 'src', 'preload.ts');
const POLICY = join(DESKTOP, 'src', 'policy.ts');
const BUILDER = join(DESKTOP, 'electron-builder.config.cjs');
const PACKAGE = join(DESKTOP, 'package.json');
const BUILD_SCRIPT = join(DESKTOP, 'scripts', 'build-work-device.cjs');
const PACKAGE_SCRIPT = join(DESKTOP, 'scripts', 'work-device-package.cjs');
const DESIGN = join(ROOT, 'docs', 'work', 'design', 'work-r0b-device-design-2026-10-30.md');
const RUST_MAIN = join(DEVICE, 'src', 'main.rs');
const RUST_DISPATCH = join(DEVICE, 'src', 'ipc', 'dispatch.rs');
const RUST_HANDSHAKE = join(DEVICE, 'src', 'ipc', 'handshake.rs');
const RUST_FRAME = join(DEVICE, 'src', 'ipc', 'frame.rs');
const RUST_TICKET = join(DEVICE, 'src', 'ipc', 'ticket.rs');

for (const p of [API, PIPE, STORE, BROKER, DRIVER, MAIN, PRELOAD, POLICY, BUILDER, PACKAGE, BUILD_SCRIPT,
  PACKAGE_SCRIPT, DESIGN, RUST_MAIN, RUST_DISPATCH, RUST_HANDSHAKE, RUST_FRAME, RUST_TICKET]) {
  assert.ok(existsSync(p), `missing ${p}`);
}
for (const name of ['work-api', 'work-pipe', 'work-store', 'work-driver', 'work-broker']) {
  assert.ok(existsSync(join(DESKTOP, 'tests', `${name}.test.cjs`)), `missing tests/${name}.test.cjs`);
}

const api = code(read(API));
const pipe = code(read(PIPE));
const store = code(read(STORE));
const broker = code(read(BROKER));
const driver = code(read(DRIVER));
const main = code(read(MAIN));
const policy = code(read(POLICY));

test('the REST face is a closed main-process endpoint table on the Bearer plane', () => {
  for (const [action, method, path] of [
    ['identity', 'GET', '/work/v2/identity'],
    ['listDevices', 'GET', '/work/v2/devices'],
    ['pair', 'POST', '/work/v2/devices/pairings'],
    ['confirmPairing', 'POST', '/work/v2/devices/pairings/{pairingId}/confirm'],
    ['mintTicket', 'POST', '/work/v2/devices/{deviceId}/session-tickets'],
    ['requestRenewal', 'POST', '/work/v2/devices/{deviceId}/certificate-renewals'],
    ['confirmRenewal', 'POST', '/work/v2/devices/certificate-renewals/{pairingId}/confirm'],
    ['revoke', 'POST', '/work/v2/devices/{deviceId}/revoke'],
    ['registerWorkspaceGrant', 'POST', '/work/v2/workspace-grants'],
    ['createLocalTaskPreview', 'POST', '/work/v2/local-task-previews'],
    ['submitLocalTask', 'POST', '/work/v2/tasks'],
  ]) {
    assert.ok(api.includes(`${action}:`) && api.includes(`path: "${path}"`), `${action} route drifted`);
  }
  assert.ok(api.includes('Authorization: `Bearer ${token}`'));
  assert.ok(api.includes('"X-Work-Client": "desktop"'));
  assert.ok(api.includes('redirect: "error"'));
  assert.ok(api.includes('AbortSignal.timeout(8000)'));
  assert.ok(api.includes('size > 262144'));
  assert.ok(api.includes('> 16384'));
  assert.ok(!/cookie/i.test(api), 'the Bearer plane must never touch cookies');
  // The closed public code vocabulary (error-codes.json device face).
  const declared = [...api.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  for (const c of ['unauthorized', 'csrf_invalid', 'invalid_request', 'not_found', 'forbidden',
    'idempotency_conflict', 'idempotency_key_conflict', 'device_revoked', 'local_policy_not_configured',
    'local_policy_incomplete', 'invalid_pagination', 'service_degraded']) {
    assert.ok(declared.includes(c), `closed code ${c} missing`);
  }
  assert.ok(api.includes('work_account_changed'));
  // The renderer bridge must not grow a Work surface.
  const preload = read(PRELOAD);
  assert.ok(!/workDevice|deliverDevice|signDevice|work\/api/.test(preload), 'preload grew a Work surface');
});

test('the pipe client matches the Broker framing, handshake, method and code closures', () => {
  const rustHandshake = read(RUST_HANDSHAKE);
  const rustFrame = read(RUST_FRAME);
  const rustDispatch = read(RUST_DISPATCH);
  const rustTicket = read(RUST_TICKET);
  const major = rustHandshake.match(/pub const PROTOCOL_MAJOR: u32 = (\d+);/)[1];
  assert.ok(pipe.includes(`export const PROTOCOL_MAJOR = ${major};`));
  assert.ok(rustFrame.includes('pub const MAX_FRAME_BYTES: usize = 64 * 1024;'));
  assert.ok(pipe.includes('export const MAX_FRAME_BYTES = 64 * 1024;'));
  assert.ok(pipe.includes('writeUInt32BE') && pipe.includes('readUInt32BE'));
  assert.ok(pipe.includes('client_kind: "shell"'));
  // Methods: the TS set covers the Rust core pump plus shell-only methods it implements.
  const ticketMethod = rustTicket.match(/pub const METHOD: &str = "([A-Za-z]+)";/)[1];
  const coreBlock = rustDispatch.split('pub const CORE_METHODS: &[&str] = &[')[1].split('];')[0];
  const rustMethods = [...coreBlock.matchAll(/"([A-Za-z]+)"/g)].map((m) => m[1])
    .concat([ticketMethod]).sort();
  const tsBlock = pipe.split('new Set<BrokerMethod>([')[1].split('])')[0];
  const tsMethods = [...tsBlock.matchAll(/"([A-Za-z]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(tsMethods, rustMethods);
  assert.equal(rustMethods.length, 22);
  // Refusal codes: same closed vocabulary on both sides.
  const codesBlock = rustDispatch.split('pub const CODES: &[&str] = &[')[1].split('];')[0];
  const rustCodes = [...codesBlock.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).sort();
  const tsCodesBlock = pipe.split('const CODES = new Set([')[1].split('])')[0];
  const tsCodes = [...tsCodesBlock.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(tsCodes, rustCodes);
  assert.equal(rustCodes.length, 9);
  assert.ok(pipe.includes('["command", "path", "url"]'));
});

test('the config file the shell writes is field-for-field the Rust BrokerConfig', () => {
  const rustConfig = read(RUST_MAIN).split('struct BrokerConfig {')[1].split('\n}')[0];
  const rustFields = [...rustConfig.matchAll(/^\s{4}([a-z_]+):/gm)].map((m) => m[1]).sort();
  const tsConfig = driver.split('export interface BrokerConfigFile {')[1].split('\n}')[0];
  const tsFields = [...tsConfig.matchAll(/^\s{2}([a-z_]+):/gm)].map((m) => m[1]).sort();
  assert.deepEqual(tsFields, rustFields);
  assert.equal(rustFields.length, 17);
  assert.ok(rustFields.includes('shell_pid'));
  assert.ok(driver.includes('shell_pid: process.pid'));
  assert.ok(driver.includes('provider: PROVIDER'));
  assert.ok(driver.includes('"Microsoft Software Key Storage Provider"'));
  // Execution-face batch 1b: the Broker owns the journal epoch (device_meta); the shell only hands
  // it a stable base directory and no longer generates or stores an epoch.
  assert.ok(driver.includes('journal_dir: path.join(this.deps.configDir, "journal")'));
  assert.ok(!driver.includes('this.journalEpoch'), 'the shell must not generate a journal epoch');
  assert.ok(!driver.includes('journal_epoch'), 'the config carries journal_dir, not journal_epoch');
  // 批2-5 (execution-face §6.4/§6.5, E3 乙): the digest placeholders are gone. The config reads the
  // shipped dev fixture profile's computed hashes; a missing/invalid profile is a hard failure (the
  // shell never falls back to a placeholder the Broker would refuse at spawn).
  assert.ok(driver.includes('dev-fixture-profile.json'), 'the config digests come from the dev fixture profile');
  assert.ok(!driver.includes('PLACEHOLDER_DIGEST'), 'no placeholder digest remains');
  assert.ok(driver.includes('work_device_bundle_profile_missing'), 'a missing profile is a hard failure');
});

test('workspace grant acquisition keeps the path in main and registers the server-issued id in Broker', () => {
  const grant = driver.split('async grantWorkspace(')[1].split('async listWorkspaceGrants')[0];
  const steps = [
    'selectWorkspaceDirectory',
    '"chooseWorkspace"',
    'confirmWorkspaceRoot',
    '"registerWorkspaceGrant"',
    '"confirmWorkspaceRoot"',
  ];
  let previous = -1;
  for (const step of steps) {
    const at = grant.indexOf(step, previous + 1);
    assert.ok(at > previous, `grant acquisition step drifted: ${step}`);
    previous = at;
  }
  assert.ok(grant.includes('root_identity_hash: facts.rootIdentityHash.slice("sha256:".length)'));
  assert.ok(grant.includes('grant_id: registered.grant_id'));
  assert.ok(grant.includes('data.grant_id !== registered.grant_id'));
  assert.ok(grant.includes('data.root_identity_hash !== facts.rootIdentityHash'));
  assert.ok(main.includes('ipcMain.handle("work:grant-workspace"'));
  assert.ok(read(PRELOAD).includes('ipcRenderer.invoke("work:grant-workspace", artifactDir)'));
  const handler = main.split('ipcMain.handle("work:grant-workspace"')[1].split('ipcMain.handle("work:list-workspace-grants"')[0];
  assert.ok(!handler.includes('selected_path'));
  assert.ok(handler.includes('workDriver.grantWorkspace(artifactDir)'));
  const rustBroker = read(join(DEVICE, 'src', 'broker.rs'));
  for (const field of ['root_identity_hash', 'device_id', 'session_id']) {
    assert.ok(rustBroker.includes(`"${field}":`), `chooseWorkspace lost ${field}`);
  }
});

test('local submission keeps approval and auth epoch in main and validates the returned proof', () => {
  const submit = driver.split('async confirmLocalSubmission(')[1].split('async listWorkspaceGrants')[0];
  const gesture = submit.indexOf('this.deps.confirmLocalSubmission(facts)');
  const pipe = submit.indexOf('this.call("confirmLocalSubmission"');
  assert.ok(gesture >= 0 && pipe > gesture, 'native confirmation must precede Broker signing');
  // The local_intent proof signs the auth_epoch the server itself put in the signed local
  // preview (lp1 payload), never the shell's local login generation: the REST face compares
  // against the Host-verified session revision (2026-11-26 identity face now republishes it).
  assert.ok(submit.includes('const authEpoch = previewAuthEpoch(input.previewHash)'));
  assert.ok(driver.includes('function previewAuthEpoch('));
  assert.ok(submit.includes('auth_epoch: authEpoch'));
  assert.ok(submit.includes('input_hash: input.inputHash.slice("sha256:".length)'));
  assert.ok(submit.includes('parseLocalIntentProof(data.local_intent, input, authEpoch)'));
  assert.ok(submit.includes('{1,4096}'), 'the server-signed local preview token needs the bounded opaque-token slot');
  assert.ok(!submit.includes('approved: input'));
  assert.ok(!submit.includes('authEpoch: input'));
  assert.ok(driver.includes('function parseLocalIntentProof('));
  assert.ok(driver.includes('expiry > now + 65_000'));
  const bridge = read(join(DESKTOP, 'src', 'work', 'bridge.ts'));
  assert.match(bridge, /confirmLocalSubmission\(\s*input: LocalSubmissionInput,?\s*\)/);
  assert.ok(read(PRELOAD).includes('ipcRenderer.invoke("work:confirm-local-submission", input)'));
  assert.ok(main.includes('ipcMain.handle("work:confirm-local-submission"'));
  assert.ok(main.includes('confirmLocalSubmission: async (facts)'));
  assert.ok(main.includes('ipcMain.handle("work:submit-local-task"'));
  assert.ok(read(PRELOAD).includes('ipcRenderer.invoke("work:submit-local-task", input)'));
  const composed = driver.split('async submitLocalTask(')[1].split('async confirmLocalSubmission')[0];
  const previewAt = composed.indexOf('"createLocalTaskPreview"');
  const confirmAt = composed.indexOf('this.confirmLocalSubmission(');
  const restAt = composed.indexOf('"submitLocalTask"');
  assert.ok(previewAt >= 0 && confirmAt > previewAt && restAt > confirmAt, 'local preview → native confirmation → REST submission order drifted');
  assert.ok(composed.includes('local_intent: localIntent'));
  assert.ok(composed.includes('profile_hash: profile.profile_hash'));
  const handler = main.split('ipcMain.handle("work:confirm-local-submission"')[1].split('ipcMain.handle("work:list-local-artifact-drafts"')[0];
  assert.ok(handler.includes('workDriver.confirmLocalSubmission(args[0])'));
  assert.ok(!handler.includes('approved'));
});

test('the device-name gesture precedes any pairing request and a cancel pairs nothing', () => {
  const pairBody = driver.split('private async pair(): Promise<boolean> {')[1].split('\n  }')[0];
  const gesture = pairBody.indexOf('askDeviceName');
  const request = pairBody.indexOf('"pair"');
  assert.ok(gesture >= 0 && request > gesture, 'the gesture must come before the pairing request');
  assert.ok(pairBody.includes('if (!name || !name.trim()) return false'));
  const startBody = driver.split('async start(): Promise<void> {')[1].split('async stop()')[0];
  assert.ok(startBody.includes('if (!paired)'));
  assert.ok(startBody.includes('this.state = "idle"'));
  // The signing pre-image fields come from the identity endpoint, not from the renderer.
  assert.match(pairBody, /org_id:\s*this\.orgId,\s*subject_id:\s*this\.subject/);
  assert.ok(startBody.includes('"identity"'));
});

test('the certificate is account-bound, persisted and re-delivered; mint and renewal are predicate-driven', () => {
  const keys = ['issuer', 'clientId', 'serviceOrigin', 'subject', 'orgId', 'deviceId', 'container',
    'certificatePem', 'certSerial', 'certNotAfter'];
  const storeKeys = store.split('const keys = [')[1].split('];')[0];
  assert.deepEqual([...storeKeys.matchAll(/"([A-Za-z]+)"/g)].map((m) => m[1]).sort(), [...keys].sort());
  assert.ok(!/token/i.test(store), 'tokens stay in DesktopAuth, never in the device record');
  for (const field of ['issuer', 'clientId', 'serviceOrigin', 'subject']) {
    assert.ok(store.includes(`record.${field} !== this.binding.${field}`), `binding fence ${field} missing`);
  }
  // Re-delivery on start goes through the restart carrier with the record's org declared
  // explicitly (a fresh Broker has no signing history); an undeliverable chain goes through
  // the renewal re-issuance path.
  assert.match(driver, /await this\.redeliver\(\s*this\.record\.deviceId,\s*this\.record\.certificatePem,\s*this\.record\.orgId,\s*this\.record\.subject,?\s*\)/);
  assert.match(driver, /"redeliverDeviceCertificate",\s*\{\s*device_id:\s*deviceId,\s*certificate_pem:\s*certificatePem,\s*org_id:\s*orgId,\s*subject_id:\s*subjectId,?\s*\}/);
  const rustBroker = read(join(DEVICE, 'src', 'broker.rs'));
  assert.ok(rustBroker.includes('"redeliverDeviceCertificate" => &["device_id", "certificate_pem", "org_id", "subject_id"]'));
  const rustIdentity = read(join(DEVICE, 'src', 'identity.rs'));
  assert.ok(rustIdentity.includes('pub fn redeliver_certificate('));
  assert.ok(driver.includes('error.code === "certificate_invalid"'));
  assert.ok(driver.includes('await this.renew()'));
  // The poll predicates: window first, then the pump's outstanding-request flag.
  assert.ok(driver.includes('data.renewal_window_open === true'));
  assert.ok(driver.includes('data.awaiting_ticket === true'));
  assert.ok(driver.includes('public_key_thumbprint: this.thumbprint'));
  // Revocation clears the record; a dead pipe stops the loop instead of hiding the exit.
  assert.ok(driver.includes('error.code === "device_revoked"'));
  assert.ok(driver.includes('["pipe_closed", "pipe_io", "pipe_unavailable"]'));
});

test('the supervisor verifies before spawn and the packaging hook pins the FINAL signed bytes', () => {
  assert.ok(broker.includes('export const WORK_DEVICE_FILE = "work-device.exe"'));
  assert.ok(broker.includes('process.platform !== "win32" || process.arch !== "x64"'));
  assert.ok(broker.includes('windowsHide: true'));
  assert.ok(broker.includes('pipe ${pipeName} ready'));
  assert.ok(broker.includes('work_device_inventory_invalid'));
  assert.ok(!broker.includes('--probe'), 'the closed entry has no probe mode; the hash pin replaces it');
  const builder = read(BUILDER);
  assert.ok(builder.includes("require('./scripts/work-device-package.cjs')"));
  assert.ok(builder.includes('withWorkDevice(withRemoteInput(config, __dirname), __dirname)'));
  const pkg = JSON.parse(read(PACKAGE));
  assert.equal(pkg.scripts['build:work-device'], 'node scripts/build-work-device.cjs');
  for (const chain of ['package', 'package:prepared', 'package:release']) {
    assert.ok(pkg.scripts[chain].includes('npm run build:work-device'), `${chain} misses the Broker build`);
  }
  assert.ok(pkg.scripts.test.includes('tests/*.test.cjs'), 'the work tests must run under npm test');
  const hook = read(PACKAGE_SCRIPT);
  assert.ok(hook.includes('signIf'));
  assert.ok(hook.includes('bundled-work-device.json'));
  assert.ok(hook.includes("to: 'work-device'"));
  assert.ok(hook.includes('!${WORK_DEVICE_FILE}'));
  // 批2-7: the pinned Node runtime is finalized + excluded from re-signing too, and the bundle ships.
  assert.ok(hook.includes('!${WORK_DEVICE_NODE_FILE}'), 'the pinned Node runtime must also be excluded from re-signing');
  assert.ok(hook.includes('nodeSha256'), 'the manifest pins the Node runtime hash');
  assert.ok(hook.includes('runtimeDigest') && hook.includes('toolManifestHash'), 'the manifest pins the bundle digests');
  assert.ok(hook.includes('${WORK_DEVICE_BUNDLE_DIR}/**'), 'the signed bundle ships in extraResources');
  assert.ok(hook.includes('verifyPackagedWorkDevice'));
  const build = read(BUILD_SCRIPT);
  assert.ok(build.includes("'build', '--release', '--bin', 'work-device'"));
  assert.ok(build.includes('fetchNodeRuntime'), 'the build stages the pinned Node runtime');
  assert.ok(build.includes('stageBundle'), 'the build stages the signed device bundle');
  // The legacy local-agent runtime composition was removed with the legacy Work module
  // (5749407fa); the chain must not resurrect it, and the manifest must verify the Broker payload.
  const manifestScript = read(join(DESKTOP, 'scripts', 'release-manifest.mjs'));
  assert.ok(!/runtime-package|bundledRuntime|packagedRuntime/.test(manifestScript));
  assert.ok(!/runtime-package|bundled-runtime/.test(builder));
  assert.ok(manifestScript.includes('verifyPackagedWorkDevice'));
  assert.ok(manifestScript.includes('packagedWorkDevice'));
});

test('main.ts wires the safeStorage record, the main-process dialog and the lifecycle stops', () => {
  assert.ok(main.includes('work-device-v1.enc'));
  assert.ok(main.includes('safeStorage'));
  assert.ok(main.includes('isEncryptionAvailable'));
  assert.ok(main.includes('bundled-work-device.json'));
  assert.ok(main.includes('askDeviceName'));
  assert.ok(main.includes('dialog.showMessageBox'));
  assert.ok(main.includes('确认配对'));
  assert.ok(main.includes('void startWorkDriver()'));
  assert.ok(main.includes('stopWorkDriver'));
  assert.ok(policy.includes('export interface WorkConfig'));
  assert.ok(policy.includes('work?: WorkConfig'));
  assert.ok(policy.includes('path.isAbsolute(value.work.caPemPath)'));
});

test('the design doc registers the dialog carrier deviation in place', () => {
  const design = read(DESIGN);
  assert.ok(design.includes('设备名确认手势的载体偏差'), '§1.1 deviation registration missing');
  assert.ok(design.includes('Electron 主进程对话框'));
  assert.ok(design.includes('GET /work/v2/identity'));
  assert.ok(design.includes('awaiting_ticket'));
});