// 2026-11-19 (批2-6, execution-face §5/E5 甲). A3 uplink PRODUCTION wiring: the live owner (the Node
// service pipe loop) triggers signed receipt + checkpoint uplinks through the journal-op channel, and
// the sync core — the journal's sole owner AND the device-key/uplink holder (E4 甲) — allocates the
// receipt seq, signs, appends the original signed envelope and uplinks, all in one transaction. This
// gate pins the cross-language seams the unit tests prove dynamically:
//   ① the journal-op channel grew AppendReceipt/PersistCheckpoint (owned facts), and execute() takes a
//     Producer (key + uplink sender + instance facts) so production signs/uplinks on the owner thread;
//   ② receipt seq allocation + signing + insert are ONE transaction (insert_receipt takes an explicit
//     seq; a failed sign/insert never burns a seq — receipt continuity is a reconcile gate);
//   ③ the outbox stores the FULL historical envelope (gateway reconcile re-uploads it verbatim,
//     base64url), the live uplink carries the signed body the link re-wraps;
//   ④ device_local model turns record a LOCAL journal fact (usage_source='device_adapter' sealed into
//     the checkpoint plaintext) and carry NO egress-only fields; they uplink NO gateway receipt and
//     consume NO gateway receipt seq (批2-7 主签单选乙; DD:264「无 gateway receipt」; the server's
//     device_adapter metering is deferred to I5, 0042:296/0021:58). The gateway receipt seq window
//     carries ACTION receipts only, so a tool write receipt is seq 1 and records (0048);
//   ⑤ the local_model_request hash is an independent kind (work-device-local-model-request-v1), never
//     the bare document hash nor the pair/renew domains;
//   ⑥ the live owner maps each reply to the closed receipt vocabulary (success/unknown/refusal) and
//     records NOTHING for pending_approval (the action awaits a future command).
// Deliberately NOT asserted: finish five-step + reconcile硬化 + ophash (批3), the real ExecutionProfile
// binding face (M4/M5 — the dev-fixture local_model_request binding.org/task + tools[] are placeholders),
// and a gateway-driven real-exe Run (批2-7 evidence).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(HERE, '..', '..', '..', '..', '..');
const DEVICE = join(ROOT, 'src', 'device');
const WORK = join(ROOT, 'src', 'work');
const read = (p) => readFileSync(p, 'utf8');

const JOURNALOP = join(DEVICE, 'src', 'journalop.rs');
const RECORD = join(DEVICE, 'src', 'journal', 'record.rs');
const RECOVER = join(DEVICE, 'src', 'journal', 'recover.rs');
const NODESERVICE = join(DEVICE, 'src', 'nodeservice.rs');
const SYNCCORE = join(DEVICE, 'src', 'synccore.rs');
const MAIN = join(DEVICE, 'src', 'main.rs');
const RECEIPT_FRAME = join(DEVICE, 'src', 'frame', 'receipt.rs');
const RECONCILE_GO = join(WORK, 'internal', 'gateway', 'reconcile.go');
const NODE_MAIN = join(WORK, 'node', 'device-bundle', 'main.js');

for (const p of [JOURNALOP, RECORD, RECOVER, NODESERVICE, SYNCCORE, MAIN, RECEIPT_FRAME, RECONCILE_GO, NODE_MAIN]) {
  assert.ok(existsSync(p), `missing ${p}`);
}

const journalop = read(JOURNALOP);
const record = read(RECORD);
const nodeservice = read(NODESERVICE);
const synccore = read(SYNCCORE);
const main = read(MAIN);

test('the journal-op channel carries owned receipt/checkpoint production ops', () => {
  assert.ok(journalop.includes('AppendReceipt {'));
  assert.ok(journalop.includes('PersistCheckpoint {'));
  assert.ok(journalop.includes('pub struct ReceiptFacts {'));
  assert.ok(journalop.includes('pub struct CheckpointFacts {'));
  assert.ok(journalop.includes('pub struct Producer<'));
  assert.ok(journalop.includes('pub struct InstanceFacts {'));
  assert.match(journalop, /ReceiptProduced\s*\{\s*seq:\s*u64,\s*signed_hash:\s*String,?\s*\}/);
  assert.ok(journalop.includes('CheckpointProduced'));
  // execute() takes the Producer so production signs/uplinks on the sole-owner thread.
  assert.ok(journalop.includes('producer: &Producer,'));
  assert.ok(journalop.includes('fn produce_receipt('));
  assert.ok(journalop.includes('fn produce_checkpoint('));
});

test('receipt seq allocation, signing and insert are one transaction (no burned seq)', () => {
  // insert_receipt takes an explicit seq; append_receipt is the allocate+insert convenience.
  assert.ok(record.includes('pub fn insert_receipt('));
  assert.ok(record.includes('seq: i64,'));
  assert.ok(record.includes('let seq = meta::allocate_receipt_seq(conn, device_id)?;'));
  assert.ok(record.includes('insert_receipt(conn, journal_epoch, seq, row)?;'));
  assert.ok(record.includes('Sign(SignError)'));
  // produce_receipt allocates → signs → inserts inside ONE unchecked_transaction, then commits.
  const body = journalop.split('fn produce_receipt(')[1].split('fn produce_checkpoint(')[0];
  const tx = body.indexOf('conn.unchecked_transaction()');
  const alloc = body.indexOf('meta::allocate_receipt_seq(&tx');
  const sign = body.indexOf('body.sign(producer.key)');
  const insert = body.indexOf('record::insert_receipt(');
  const commit = body.indexOf('tx.commit()');
  assert.ok(tx >= 0 && alloc > tx && sign > alloc && insert > sign && commit > insert,
    'allocate → sign → insert → commit must be ordered inside one transaction');
  // device_local carries no egress-only fields.
  assert.ok(body.includes('gateway_receipt_hash: None'));
});

test('the outbox stores the full historical envelope the gateway reconcile re-uploads', () => {
  const body = journalop.split('fn produce_receipt(')[1].split('fn produce_checkpoint(')[0];
  assert.ok(body.includes('envelope::Envelope::new(receipt::FRAME_TYPE'));
  assert.ok(body.includes('env.session_id = facts.session_id'));
  assert.ok(body.includes('env.agent_instance_id = producer.instance.agent_instance_id'));
  assert.ok(body.includes('env.boot_id = producer.instance.boot_id'));
  assert.ok(body.includes('let signed_bytes = serde_json::to_vec(&env)'));
  assert.ok(body.includes('signed_hash = format!("sha256:{}", crate::sha256_hex(&signed_bytes))'));
  // The live uplink carries the signed body (the link re-wraps it in the current transport envelope).
  assert.ok(body.includes('frame_type: receipt::FRAME_TYPE.to_string()'));
  // The gateway nests base64url of a FULL original receipt ENVELOPE (not just the body).
  const go = read(RECONCILE_GO);
  assert.ok(go.includes('base64url (no padding) of a full original receipt ENVELOPE'));
  assert.ok(go.includes('SignedReceiptBytes []string'));
});

test('the checkpoint seals the body locally and uplinks a signed commit at the receipt watermark', () => {
  const body = journalop.split('fn produce_checkpoint(')[1].split('fn current_receipt_seq(')[0];
  assert.ok(body.includes('recover::persist_checkpoint(journal.connection(), journal.dek()'));
  assert.ok(body.includes('checkpoint::CheckpointCommitBody {'));
  assert.ok(body.includes('let receipt_through_seq = current_receipt_seq(journal);'));
  assert.ok(body.includes('commit.sign(producer.key)'));
  assert.ok(body.includes('frame_type: checkpoint::COMMIT_FRAME_TYPE.to_string()'));
  // The commit carries only hashes + an opaque ref, never ciphertext.
  assert.ok(!body.includes('ciphertext'));
  assert.ok(read(RECOVER).includes('pub fn persist_checkpoint('));
});

test('the live owner produces receipts/checkpoints and maps the closed receipt vocabulary', () => {
  // serve_run drives production per model turn / tool call.
  const serve = nodeservice.split('fn serve_run(')[1].split('const MODEL_REQUEST_KIND')[0];
  assert.ok(serve.includes('produce_model_receipt('));
  assert.ok(serve.includes('produce_tool_receipt('));
  assert.ok(serve.includes('let mut checkpoint_seq: i64 = 0;'));
  // The independent request-hash kind (§5.1, DD:239/57).
  assert.ok(nodeservice.includes('const MODEL_REQUEST_KIND: &str = "work-device-local-model-request-v1";'));
  const hashFn = nodeservice.split('fn model_request_hash(')[1].split('\n}')[0];
  assert.ok(hashFn.includes('MODEL_REQUEST_KIND'));
  assert.ok(hashFn.includes("covered.push(b'|')"));
  // device_local usage stamped device_adapter; success/unknown/refusal mapping.
  assert.ok(nodeservice.includes('usage_source: Some("device_adapter".into())'));
  assert.ok(nodeservice.includes('nodemsg::MODEL_UNKNOWN =>'));
  assert.ok(nodeservice.includes('"rejected_not_executed"'));
  // pending_approval records NOTHING (no execution decision yet).
  const toolFn = nodeservice.split('fn produce_tool_receipt(')[1].split('\n}\n')[0];
  assert.ok(toolFn.includes('if reason == "pending_approval"'));
  assert.ok(toolFn.includes('return;'));
  // A write binds the dispatched command's operation_id + request_hash; a read uses the logical_key.
  assert.ok(toolFn.includes('.map(|c| c.operation_id.clone())'));
  assert.ok(toolFn.includes('.map(|c| c.request_hash.clone())'));
});

test('device_local model turns are local-only: no gateway receipt seq, no record_device_receipt uplink (乙)', () => {
  // 批2-7 主签单选乙 (DD:264「无 gateway receipt」; server device_adapter metering deferred to I5,
  // 0042:296/0021:58). produce_model_receipt routes to record_model_turn (a sealed local checkpoint),
  // NOT record_operation (which allocates a gateway receipt seq + uplinks record_device_receipt). A
  // model receipt sent to the action-receipt gate (0048) is refused and burns the contiguous seq window
  // the tool write receipt needs; the gateway receipt seq window therefore carries ACTION receipts only.
  const modelFn = nodeservice.split('fn produce_model_receipt(')[1].split('\n}\n')[0];
  assert.ok(modelFn.includes('record_model_turn('), 'the model turn records locally');
  assert.ok(!modelFn.includes('record_operation('), 'the model turn must not allocate a gateway receipt seq');
  const turnFn = nodeservice.split('fn record_model_turn(')[1].split('\n}\n')[0];
  assert.ok(turnFn.includes('JournalOp::PersistCheckpoint {'), 'the model turn seals a local checkpoint');
  assert.ok(!turnFn.includes('AppendReceipt'), 'the model turn uplinks no gateway receipt');
  assert.ok(turnFn.includes('"usage_source": facts.usage_source'), 'device_adapter usage is sealed locally');
  assert.ok(turnFn.includes('prior_receipt_ref: None'), 'no gateway receipt precedes the model turn');
  // The action receipt path still allocates the gateway seq + uplinks (the tool write receipt is seq 1).
  const opFn = nodeservice.split('fn record_operation(')[1].split('\n}\n')[0];
  assert.ok(opFn.includes('JournalOp::AppendReceipt {'));
});

test('the sync core provisions the Producer and refreshes the watermark; the entry supplies instance facts', () => {
  assert.ok(synccore.includes('let producer = crate::journalop::Producer {'));
  assert.ok(synccore.includes('key: core.key.as_ref(),'));
  assert.ok(synccore.includes('uplinks: &core.uplinks,'));
  assert.ok(synccore.includes('instance: &core.instance,'));
  assert.ok(synccore.includes('core.last_receipt_seq = current_receipt_seq(core.journal(), &core.device_id);'));
  assert.ok(synccore.includes('instance: crate::journalop::InstanceFacts,'));
  // The instance facts come from the closed BrokerConfig (no new config fields).
  assert.ok(main.includes('work_device::journalop::InstanceFacts {'));
  assert.ok(main.includes('agent_instance_id: cfg.agent_instance_id.clone(),'));
  assert.ok(main.includes('boot_id: cfg.boot_id.clone(),'));
});

test('the Node bundle constructs the local_model_request v1 doc the Broker hashes', () => {
  const node = read(NODE_MAIN);
  assert.ok(node.includes('function buildModelRequest('));
  // The closed §5.1 top-level fields exist (binding.org/task + tools[] completeness is the M4/M5
  // ExecutionProfile binding face; the dev fixture carries placeholders, registered as deferred).
  for (const field of ['v: 1', 'binding:', 'route:', 'parameters:', 'template:', 'source_manifest_hash:', 'messages', 'tools:']) {
    assert.ok(node.includes(field), `local_model_request field ${field} missing`);
  }
  assert.ok(node.includes('logical_key: `model:${turnNo}`'));
  // The receipt frame's historical identity carries the short wire names the gateway translates.
  const receipt = read(RECEIPT_FRAME);
  assert.ok(receipt.includes('pub struct OriginalExecution {'));
  assert.ok(receipt.includes('pub agent_instance: String'));
  assert.ok(receipt.includes('pub boot: String'));
});