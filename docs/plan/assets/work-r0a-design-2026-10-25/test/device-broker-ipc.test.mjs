// 2026-11-17 (GW18). GW17 landed the two halves of the ticket path with NOTHING between them:
// `PipeServer`, `Handshake`, `TicketSlot` and `deliver_message` all had zero callers outside their
// own modules, and `LinkEvent::AwaitingTicket` was declared but never emitted. This guard pins the
// wiring that closed that gap, and the four rulings it was built under (ticket path only / push
// model + AwaitingTicket / explicit closed refusals / two-half evidence + a local full-chain run):
//   - the pipe loop really dispatches, and the pump really calls deliver_message (one closure path);
//   - a single-use ticket is withdrawn ONLY while a link request is outstanding, never queued ahead
//     of need, and the link announces a wait ONLY when its ticket channel is empty;
//   - `method_not_implemented` and `unknown_method` stay distinct, so a legal-but-unlanded call is
//     never reported as an illegal one (§1: explicit error, never a silent downgrade);
//   - the client hello is closed and a protocol major above u32::MAX cannot truncate into a match;
//   - the platform seam is registered honestly: the pipe is Windows-only, the PostgreSQL fixture is
//     Linux-only, so NO CI job claims the full chain and the broker probe refuses to run elsewhere.
//
// Deliberately NOT asserted here: downlink verification, journal registration or sidecar dispatch.
// The lead ruled GW18 = the ticket path only; A2 stays deferred because the device side has no sync
// core yet, so a downlink router would have no caller. A gate demanding consumption would be
// demanding unruled scope — and this one asserts the opposite, that the pump consumes nothing else.
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
// Comments state intent; only code lines may satisfy a structural assertion. Rust has no '#'
// comment, and stripping '#' lines would delete every #[cfg(...)] attribute — which is exactly
// what the platform-boundary assertions below need to see.
const code = (t) => t.split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join('\n');
// The production half of a Rust file: a test module may legitimately import anything.
const prod = (t) => code(t.split('#[cfg(test)]')[0]);

const SERVICE = join(DEVICE, 'src', 'ipc', 'service.rs');
const DISPATCH = join(DEVICE, 'src', 'ipc', 'dispatch.rs');
const BROKER = join(DEVICE, 'src', 'broker.rs');
const NODESERVICE = join(DEVICE, 'src', 'nodeservice.rs');
const HANDSHAKE = join(DEVICE, 'src', 'ipc', 'handshake.rs');
const TICKET = join(DEVICE, 'src', 'ipc', 'ticket.rs');
const LINK = join(DEVICE, 'src', 'transport', 'link.rs');
const TRANSPORT = join(DEVICE, 'src', 'transport', 'mod.rs');
const IPC_MOD = join(DEVICE, 'src', 'ipc', 'mod.rs');
const LIB = join(DEVICE, 'src', 'lib.rs');
const MAIN = join(DEVICE, 'src', 'main.rs');
const BROKER_PROBE = join(DEVICE, 'examples', 'device_broker_probe.rs');
const BROKER_INTEROP = join(GATEWAY, 'interop_broker_test.go');

for (const p of [SERVICE, DISPATCH, BROKER, NODESERVICE, HANDSHAKE, TICKET, LINK, TRANSPORT, IPC_MOD, LIB,
  MAIN, BROKER_PROBE, BROKER_INTEROP]) {
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

test('the pipe loop dispatches and the pump is the single closure-then-slot path', () => {
  const service = code(read(SERVICE));
  const broker = code(read(BROKER));
  // GW17's registered gap was exactly this: no loop called deliver_message.
  assert.match(service, /classify\(&message\)/);
  assert.match(service, /Dispatch::Core/);
  assert.match(service, /blocking_send\(DeliveryRequest/);
  assert.match(service, /blocking_recv\(\)/);
  // GW21 moved the call into handle_message, which owns every method's closure-then-state path.
  // The single-path property is unchanged: exactly one deliver_message call site in the pump.
  assert.match(broker, /ticket::deliver_message\(slot, message, Instant::now\(\)\)/);
  assert.equal(prod(read(BROKER)).split('ticket::deliver_message(').length - 1, 1,
    'a second deliver_message call site would let two paths disagree');
  assert.match(broker, /fn handle_message\(\s*identity: &mut Identity,\s*slot: &mut TicketSlot,\s*awaiting: bool,\s*message: &Value,?\s*\) -> Reply/);
  // Validation is NOT duplicated in the pipe loop: one path, so the two cannot disagree.
  assert.ok(!service.includes('ticket::parse'), 'the pipe loop re-validates the ticket itself');
  assert.ok(!service.includes('slot.deliver'), 'the pipe loop owns a slot it must not own');
  // The loop is declared Windows-only and the pump is cross-platform, so the Linux job still builds.
  const mod = read(IPC_MOD);
  assert.match(mod, /#\[cfg\(windows\)\]\npub mod service;/);
  assert.match(mod, /^pub mod dispatch;/m);
  assert.match(read(LIB), /^pub mod broker;/m);
});

test('the reply vocabulary is closed and the two refusal kinds stay distinct', () => {
  const dispatch = read(DISPATCH);
  const src = code(dispatch);
  const closure = dispatch.slice(dispatch.indexOf('pub const CODES'), dispatch.indexOf('];', dispatch.indexOf('pub const CODES')));
  for (const c of ['unknown_method', 'method_not_implemented', 'schema', 'shape',
    'foreign_device', 'already_consumed', 'handshake', 'no_pairing', 'certificate_invalid']) {
    assert.ok(closure.includes(`"${c}"`), `${c} left the closed refusal set`);
  }
  assert.match(dispatch, /assert_eq!\(CODES\.len\(\), 9\)/);
  // The routing decision: unknown ≠ unlanded ≠ malformed, and only the ticket method reaches the pump.
  const classify = fnBody(src, 'pub fn classify(');
  assert.match(classify, /SchemaError::UnknownMethod/);
  assert.match(classify, /"unknown_method"/);
  assert.match(classify, /SchemaError::MissingMethod\) \| Err\(SchemaError::ForbiddenField/);
  assert.match(classify, /"method_not_implemented"/);
  assert.match(classify, /CORE_METHODS\.contains\(&method\)/);
  // Accepted carries three keys, refused four; the echo never invents a correlation id.
  assert.match(src, /"request_id": self\.request_id/);
  assert.match(dispatch, /assert_eq!\(keys, \["method", "request_id", "result"\]\)/);
  assert.match(dispatch, /assert_eq!\(keys, \["code", "method", "request_id", "result"\]\)/);
  assert.match(dispatch, /assert_eq!\(count, 7\)/);
  assert.match(dispatch, /assert_eq!\(SHELL_METHODS\.len\(\), 29\)/);
  assert.match(dispatch, /assert_eq!\(CORE_METHODS\.len\(\), 22\)/);
});

test('local submission requires approval, live input facts and the Broker device signature', () => {
  const broker = code(read(BROKER));
  const submission = fnBody(broker, 'async fn submission_reply(');
  assert.match(submission, /let Some\(approved\) = message\.get\("approved"\)\.and_then\(Value::as_bool\)/);
  const cancel = submission.indexOf('if !approved');
  const canceled = submission.indexOf('return Reply::accepted(message);', cancel);
  assert.ok(cancel >= 0 && canceled > cancel, 'cancel must return before any proof or node request');
  assert.match(submission, /NodeRequest::ValidateLocalSubmission/);
  assert.match(submission, /proof\.validate\(\)/);
  assert.match(submission, /identity\.sign_local_intent\(/);
  assert.match(submission, /request_id: text\("client_request_id"\)/,
    'the proof must bind the submit idempotency key, not the pipe correlation id');
  assert.match(submission, /Duration::from_secs\(60\)/);
  assert.ok(!submission.includes('selected_path'), 'a renderer path reached the submission proof');
  const node = prod(read(NODESERVICE));
  assert.match(node, /fn staged_input_hash\(/);
  assert.match(node, /exec\.staged_input_hash\(&input_ref\)\.as_deref\(\) != Some\(&input_hash\)/);
  assert.match(node, /exec\.grants\.contains\(grant_id\)/);
});

test('a single-use ticket is withdrawn only while a link request is outstanding', () => {
  // The no-lock rule governs the production pump; its test fixture legitimately shares the
  // io_deadline with Arc<Mutex<..>> when it spawns run_core_pump (prod()'s stated scope).
  const src = prod(read(BROKER));
  const withdraw = fnBody(src, 'async fn withdraw(');
  const guard = withdraw.indexOf('if !*awaiting');
  const take = withdraw.indexOf('slot.take(now)');
  assert.ok(guard >= 0 && take > guard,
    'the awaiting guard must precede the withdrawal, or a ticket is spent ahead of need');
  // The request flag is set ONLY by the link's wait signal, and cleared only on a successful supply.
  const run = fnBody(src, 'pub async fn run_core_pump(');
  const setAt = run.indexOf('awaiting = true');
  assert.ok(setAt >= 0, 'nothing ever sets the outstanding-request flag');
  assert.ok(run.slice(0, setAt).includes('Some(LinkEvent::AwaitingTicket)'),
    'the request flag is set by something other than the link wait');
  assert.ok(!run.includes('awaiting = true;'.repeat(2)), 'duplicate request flags');
  const supply = fnBody(src, 'async fn withdraw(');
  assert.match(supply, /\*awaiting = false;/);
  // A delivery satisfies an outstanding request, and nothing else withdraws.
  assert.match(run, /if awaiting \{/);
  assert.equal(run.split('withdraw(&mut slot').length - 1, 2,
    'withdrawal must be reachable from exactly the delivery arm and the wait arm');
  // The slot is owned by the pump alone: no lock, no second owner.
  assert.ok(!src.includes('Mutex'), 'the pump introduced a lock into the sync core');
  assert.ok(!src.includes('Arc<'), 'the pump shares the slot instead of owning it');
});

test('the link announces a wait only when its ticket channel is empty', () => {
  const src = code(read(LINK));
  const run = fnBody(src, 'pub async fn run(');
  const empty = run.indexOf('tickets.is_empty()');
  const announce = run.indexOf('LinkEvent::AwaitingTicket');
  const wait = run.indexOf('let ticket = loop');
  for (const [name, at] of [['empty guard', empty], ['announcement', announce], ['ticket wait', wait]]) {
    assert.ok(at >= 0, `run lost the ${name}`);
  }
  assert.ok(empty < announce && announce < wait,
    'the wait must be announced before blocking, and only when no ticket is buffered');
  // A buffered ticket must NOT trigger a second withdrawal of a single-use ticket.
  assert.match(run, /tickets\.is_empty\(\)\s*&&\s*events\.send\(LinkEvent::AwaitingTicket\)/);
  // The variant's documented meaning matches the emission, so the next reader does not "fix" it.
  assert.match(read(TRANSPORT), /ONLY when the ticket channel is empty/);
  assert.match(read(LINK), /async fn a_buffered_ticket_is_not_announced_as_a_wait/);
});

test('the pump consumes the wait and forwards every other event verbatim', () => {
  const src = code(read(BROKER));
  const run = fnBody(src, 'pub async fn run_core_pump(');
  const waitArm = run.slice(run.indexOf('Some(LinkEvent::AwaitingTicket)'), run.indexOf('Some(LinkEvent::Stopped)'));
  assert.ok(!waitArm.includes('core_events.send'),
    'forwarding AwaitingTicket would make the core treat a normal wait as a failure');
  const otherArm = run.slice(run.indexOf('Some(other) =>'), run.indexOf('None => return BridgeOutcome::LinkGone'));
  assert.match(otherArm, /core_events\.send\(other\)\.await\.is_err\(\)/);
  assert.match(otherArm, /BridgeOutcome::CoreGone/);
  // A closed delivery channel must stop being polled, or the select spins.
  assert.match(run, /request = deliveries\.recv\(\), if deliveries_open/);
  assert.match(run, /deliveries_open = false;/);
  // A gone shell with an unsatisfiable request ends the pump instead of hanging the link's dial.
  assert.match(run, /Pump::Waiting if !deliveries_open => return BridgeOutcome::ShellGone/);
  // Scope: the pump body touches no journal, no sidecar and no permit — A2 consumption stays deferred.
  // Confirmation helpers elsewhere in broker.rs may validate journal-owned provenance; they are not
  // part of the ticket pump this test governs.
  const pump = fnBody(prod(read(BROKER)), 'pub async fn run_core_pump(');
  for (const forbidden of ['journal::', 'sidecar::', 'permit::', 'reconcile::', 'recovery::']) {
    assert.ok(!pump.includes(forbidden), `the pump reached into ${forbidden}, which GW18 did not rule`);
  }
});

test('the client hello is closed and a protocol major cannot truncate into a match', () => {
  const src = code(read(HANDSHAKE));
  const parse = fnBody(src, 'pub fn parse_client_hello(');
  assert.match(parse, /keys != \["client_kind", "nonce", "protocol_major"\]/);
  // `as u32` would turn 2^32+2 into 2 and accept a wrong protocol version.
  assert.match(parse, /u32::try_from\(/);
  assert.ok(!/protocol_major.*\bas u32\b/.test(parse), 'the major is cast, not range-checked');
  assert.match(parse, /"shell" => ClientKind::Shell/);
  assert.match(parse, /"node" => ClientKind::Node/);
  assert.match(parse, /_ => return Err\(HandshakeError::Schema\)/);
  // The server hello is two keys, and the shell pipe refuses the other ACL/message set.
  assert.match(src, /json!\(\{"nonce": self\.nonce, "protocol_major": PROTOCOL_MAJOR\}\)/);
  const service = code(read(SERVICE));
  const conn = fnBody(service, 'pub fn serve_connection(');
  const kindAt = conn.indexOf('hello.client_kind == ClientKind::Shell');
  const verifyAt = conn.indexOf('handshake.verify(&hello)');
  assert.ok(kindAt >= 0 && verifyAt > kindAt, 'the shell kind must be checked before the handshake is spent');
  assert.match(conn, /refuse_handshake\(conn\)/);
  // The truncation case is pinned by name and by the values it drives, not by rustfmt's layout.
  const majorTest = fnBody(read(HANDSHAKE), 'fn a_protocol_major_above_u32_is_refused_not_truncated(');
  assert.match(majorTest, /u64::from\(u32::MAX\) \+ u64::from\(PROTOCOL_MAJOR\)/);
  assert.match(majorTest, /u64::MAX/);
  assert.match(majorTest, /Err\(HandshakeError::Schema\)/);
});

test('a refused client ends one connection, a gone pump ends the server', () => {
  const src = code(read(SERVICE));
  const serve = fnBody(src, 'pub fn serve_shell_pipe(');
  // One hostile or buggy caller must not take the shell channel down.
  assert.match(serve, /Err\(_\) => continue/);
  assert.match(serve, /if deliveries\.is_closed\(\)/);
  assert.match(serve, /return Err\(PipeError::Broker\)/);
  const conn = fnBody(src, 'pub fn serve_connection(');
  assert.match(conn, /if deliveries\.is_closed\(\)/);
  // A malformed payload is answered, not dropped and not treated as a departure.
  const readMsg = fnBody(src, 'fn read_message(');
  assert.match(readMsg, /Read::NotJson/);
  assert.match(readMsg, /Read::Gone/);
  assert.match(conn, /Read::NotJson => \{/);
  assert.match(conn, /Reply::refused\(&Value::Null, "schema"\)/);
  // The handshake refusal is written before the disconnect, so the caller learns why.
  const refuse = fnBody(src, 'fn refuse_handshake(');
  assert.match(refuse, /Reply::handshake\(\)/);
  assert.match(refuse, /Err\(PipeError::Handshake\)/);
});

test('the real Windows pipe is exercised, not a fake connection', () => {
  const service = read(SERVICE);
  const src = code(service);
  assert.match(src, /CreateFileW\(/);
  assert.match(src, /serve_shell_pipe\(&server_name, shell_pid, delivery_tx\)/);
  assert.match(src, /run_core_pump\(/);
  assert.match(src, /std::thread::spawn/);
  // The centerpiece: a delivery crosses pipe → dispatch → pump → slot → the link's ticket channel.
  assert.match(service, /async fn a_real_pipe_delivery_reaches_the_link_ticket_channel|fn a_real_pipe_delivery_reaches_the_link_ticket_channel/);
  const centerpiece = fnBody(src, 'fn a_real_pipe_delivery_reaches_the_link_ticket_channel(');
  assert.match(centerpiece, /h\.ask\(\)/);
  assert.match(centerpiece, /client\.write\(&delivery\(TICKET, "row-1"\)\)/);
  assert.match(centerpiece, /assert_eq!\(h\.next_ticket\(\)\.as_deref\(\), Some\(TICKET\)\)/);
  // Every unlanded shell method is answered over the real pipe, and the channel survives it.
  assert.match(service, /fn every_unimplemented_shell_method_gets_an_explicit_refusal_over_the_pipe/);
  assert.match(service, /assert_eq!\(count, 7\)/);
});

test('the broker probe cannot dial without the pipe and refuses other platforms', () => {
  const probe = read(BROKER_PROBE);
  const src = code(probe);
  // No ticket member at all: a session established by this probe proves the pipe path crossed.
  const config = probe.slice(probe.indexOf('struct ProbeConfig'), probe.indexOf('\n    }', probe.indexOf('struct ProbeConfig')));
  assert.ok(!/^\s*ticket:/m.test(config), 'the broker probe config carries a ticket, so the pipe is not proven');
  assert.match(config, /pipe_name: String/);
  assert.match(config, /shell_pid: u32/);
  assert.match(src, /#\[cfg\(not\(windows\)\)\]\s*\n\s*fail\(/);
  assert.match(src, /use work_device::broker::\{run_core_pump, ReadyIdentity\};/);
  assert.match(src, /use work_device::ipc::service::serve_shell_pipe;/);
  assert.match(src, /use work_device::transport::link::Link;/);
  assert.match(src, /serve_shell_pipe\(&pipe_name, shell_pid, delivery_tx\)/);
  // No reimplementation of the device side.
  for (const forbidden of ['sign_es256', 'jcs::', 'hello_ack', 'schema_version']) {
    assert.ok(!src.includes(forbidden), `the broker probe re-implements ${forbidden}`);
  }
  // GW21 closed GW18's "no executable Broker entry" boundary: main.rs is now the real process,
  // so the assertion REVERSES. The probe stays a test artifact (never named in Cargo.toml).
  assert.match(read(MAIN), /serve_shell_pipe\(&pipe_name, shell_pid, delivery_tx\)/);
  assert.match(read(MAIN), /run_core_pump\(/);
  assert.match(read(MAIN), /#\[serde\(deny_unknown_fields\)\]/);
  assert.ok(!read(join(DEVICE, 'Cargo.toml')).includes('device_broker_probe'));
  assert.match(probe, /PROBE_REPORT /);
});

test('the Go shell client speaks the real framing and asserts server-side truth', () => {
  const go = read(BROKER_INTEROP);
  assert.match(go, /binary\.BigEndian\.Uint32\(prefix\[:\]\)/);
  assert.match(go, /binary\.BigEndian\.PutUint32\(frame\[:4\], uint32\(len\(raw\)\)\)/);
  assert.match(go, /size > 64\*1024/);
  assert.match(go, /"nonce": nonce, "protocol_major": 2, "client_kind": "shell"/);
  assert.match(go, /len\(hello\) != 2/);
  // Both refusal kinds, the closed accepted shape, and the single-use replay refusal.
  for (const needle of ['method_not_implemented', 'unknown_method', 'already_consumed',
    'len(accepted) != 3', 'work.device_session', 'work.device_session_ticket', 'consumed',
    'alive_ms', 'pipe_stopped', 'LinkStopped']) {
    assert.ok(go.includes(needle), `the broker interop no longer asserts ${needle}`);
  }
  // The ticket is the real mint output shape, not the GW17 placeholder that never passed the gate.
  assert.match(go, /ticket := sha256Hex\(uuid\.NewString\(\) \+ uuid\.NewString\(\)\)/);
  assert.match(go, /len\(ticket\) != 64/);
  // The dedup key is the server's own row id, read back rather than fabricated.
  assert.match(go, /ticketRow := ticketRowID\(t, f, ticket\)/);
  assert.match(go, /SELECT id::text FROM work\.device_session_ticket/);
  // The config handed to the probe must not carry a ticket.
  assert.match(go, /if _, ok := config\["ticket"\]; ok \{/);
  assert.match(go, /jwkThumbprint\(t, report\["device_public_jwk"\]\); got != f\.thumbprint/);
});

test('the platform seam is registered: no CI job claims the full chain', () => {
  const go = read(BROKER_INTEROP);
  // A runtime skip, not a build tag: the go-test-surface gate forbids tags on _test.go files.
  assert.match(go, /runtime\.GOOS != "windows"/);
  assert.match(go, /t\.Skipf\(/);
  assert.ok(!/^\/\/go:build/m.test(go), 'the broker interop carries a build tag');
  const env = go.match(/brokerBinEnv = "([^"]+)"/);
  assert.ok(env, 'interop_broker_test.go no longer names its env constant');
  assert.equal(env[1], 'WORK_DEVICE_BROKER_BIN');
  assert.match(go, /os\.Getenv\(brokerBinEnv\)/);
  assert.match(go, /os\.Stat\(bin\)/);
  // No workflow sets it, so CI never pretends the Windows-only pipe crossed the Linux-only chain.
  for (const file of readdirSync(WORKFLOWS).filter((f) => f.endsWith('.yml'))) {
    const yaml = read(join(WORKFLOWS, file));
    assert.ok(!yaml.includes('WORK_DEVICE_BROKER_BIN'),
      `${file} claims the broker seam; the pipe is Windows-only and the PG fixture is Linux-only`);
    assert.ok(!yaml.includes('device_broker_probe'), `${file} builds a probe it cannot run`);
  }
  // GW17's Linux evidence must stay intact: the link probe is still built and handed over.
  const gates = read(join(WORKFLOWS, 'work-r0a-gates.yml'));
  assert.match(gates, /cargo build --example device_link_probe/);
  assert.match(gates, /WORK_DEVICE_INTEROP_BIN:/);
  // The boundary is written down where a reader will find it, not only in this gate.
  assert.match(read(BROKER_PROBE), /LOCAL full-chain run, registered as not covered by CI/);
  assert.match(go, /deliberately NOT set by any CI job/);
});

test('the ticket lifecycle the pump depends on is still the GW17 one', () => {
  const ticket = read(TICKET);
  // The pump adds no second expiry, no second dedup set and no queue.
  assert.match(code(ticket), /pub const TICKET_TTL: Duration = Duration::from_secs\(60\)/);
  assert.match(code(ticket), /pub fn deliver_message\(/);
  assert.match(code(ticket), /self\.consumed\s*\n?\s*\.insert\(pending\.delivery\.session_ticket_id\.clone\(\), now\)/);
  const broker = prod(read(BROKER));
  const pump = fnBody(broker, 'pub async fn run_core_pump(') + fnBody(broker, 'async fn withdraw(');
  assert.ok(!broker.includes('const TICKET_TTL'), 'the pump re-declares the holding window');
  assert.ok(!pump.includes('Duration::from_secs(60)'), 'the ticket pump guesses a TTL instead of using the slot');
  // The slot's own retirement of an expired id is what makes the shell's refusal explicit.
  assert.match(ticket, /fn prune\(&mut self, now: Instant\)/);
  assert.match(read(DISPATCH), /TicketError::Empty \| TicketError::Expired => "already_consumed"/);
  assert.match(read(DISPATCH), /fn deliveries_never_report_withdrawal_errors/);
});
