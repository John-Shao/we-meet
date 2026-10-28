// Pure design model: no database, network, lease enforcement or provider execution.
import { createHash } from 'node:crypto';

const domains = {
  model_request: 'work-model-request-v1',
  canonical_state: 'work-canonical-v1',
  model_receipt: 'work-model-receipt-v1',
};

export function canonicalJson(value) {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') {
    if (!value.isWellFormed()) throw new Error('invalid_unicode');
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) throw new Error('invalid_integer');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + Array.from(value, canonicalJson).join(',') + ']';
  }
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return '{' + Object.keys(value).sort().map((key) => canonicalJson(key) + ':' + canonicalJson(value[key])).join(',') + '}';
  }
  throw new Error('invalid_json_value');
}

export function documentHash(document) {
  const domain = Object.hasOwn(domains, document.kind) ? domains[document.kind] : null;
  if (!domain || document.schemaVersion !== domain) throw new Error('unsupported_version');
  const bytes = Buffer.from(domain + '\n' + canonicalJson(document), 'utf8');
  if (bytes.length > 262144) throw new Error('document_too_large');
  return 'sha256:' + createHash('sha256').update(bytes).digest('hex');
}

export function deliveryTransition(gate, event) {
  if (event.kind === 'consume') {
    if (gate !== null) return { gate, won: false };
    return { gate: { state: 'consumed', invocationId: event.invocationId, receiptHash: null }, won: true };
  }
  if (event.kind === 'seal') {
    if (gate !== null) return { gate, sealed: gate.state === 'sealed_not_sent' };
    return { gate: { state: 'sealed_not_sent', invocationId: null, receiptHash: null }, sealed: true };
  }
  if (event.kind === 'attach') {
    if (gate === null || gate.state === 'sealed_not_sent') throw new Error('receipt_without_consumption');
    if (gate.receiptHash !== null && gate.receiptHash !== event.receiptHash) throw new Error('receipt_conflict');
    return { gate: { ...gate, state: 'receipt_recorded', receiptHash: event.receiptHash } };
  }
  throw new Error('invalid_gate_event');
}
