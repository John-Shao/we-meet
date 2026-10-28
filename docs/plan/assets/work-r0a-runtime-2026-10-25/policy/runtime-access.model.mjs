// Design-only authorization model; inputs represent already verified server-side records.
export function serviceActionAllowed(policy, peer, action) {
  return peer.verified === true && peer.revoked === false &&
    Object.hasOwn(policy.authorityActions, peer.role) &&
    policy.authorityActions[peer.role].includes(action);
}

export function runtimeAccessDecision(policy, facts) {
  const { authenticated, authorityAvailable, credential, execution, request, resource, now } = facts;
  if (authenticated !== true || authorityAvailable !== true) return 'deny';
  if (!credential || !execution || !request || !Number.isSafeInteger(now)) return 'deny';
  if (!Number.isSafeInteger(credential.issuedAt) || !Number.isSafeInteger(credential.expiresAt) ||
      credential.issuedAt > now || credential.expiresAt <= now ||
      credential.expiresAt <= credential.issuedAt ||
      credential.expiresAt - credential.issuedAt > policy.capability.maxTtlSeconds * 1000) return 'deny';
  if (credential.revoked !== false || execution.state !== 'active' ||
      execution.current !== true || execution.canceled !== false || execution.deleted !== false ||
      !Number.isSafeInteger(execution.leaseUntil) || execution.leaseUntil <= now ||
      !Number.isSafeInteger(execution.hardDeadline) || execution.hardDeadline <= now ||
      credential.expiresAt > Math.min(execution.leaseUntil, execution.hardDeadline)) return 'deny';
  for (const field of ['orgId', 'taskId', 'runId', 'executionId', 'holderId', 'fence', 'mode']) {
    if (typeof execution[field] !== 'string' || !execution[field] || credential[field] !== execution[field]) return 'deny';
  }
  if (request.executionId !== execution.executionId ||
      credential.audience !== request.audience ||
      !Number.isSafeInteger(credential.generation) || credential.generation < 1 ||
      execution.capabilityGenerations?.[credential.audience] !== credential.generation) return 'deny';
  const audience = Object.hasOwn(policy.audiences, credential.audience) ? policy.audiences[credential.audience] : null;
  const actions = audience && Object.hasOwn(audience, execution.mode) ? audience[execution.mode] : null;
  if (!actions?.includes(request.action)) return 'deny';

  if (request.audience === 'work-egress') {
    for (const field of ['operationId', 'dispatchAttemptId', 'requestHash']) {
      if (typeof execution[field] !== 'string' || !execution[field] || credential[field] !== execution[field]) return 'deny';
    }
    if (execution.operationState !== 'dispatching' || execution.gateState !== 'absent' ||
        request.requestHash !== execution.requestHash) return 'deny';
    return 'requires_atomic_gate_consume';
  }

  if (!resource || resource.tombstoned !== false || request.refId !== resource.refId ||
      typeof resource.refId !== 'string' || !resource.refId ||
      typeof resource.hash !== 'string' || !resource.hash || request.hash !== resource.hash) return 'deny';
  for (const field of ['orgId', 'taskId', 'runId']) {
    if (resource[field] !== execution[field]) return 'deny';
  }
  if (request.action === 'read_bound_object') {
    return resource.readableByExecutions?.includes(execution.executionId) === true &&
      resource.immutable === true ? 'allow_read' : 'deny';
  }
  const expectedKind = request.action === 'write_model_request' ? 'model_request' : 'checkpoint_candidate';
  return resource.kind === expectedKind && resource.slotExecutionId === execution.executionId &&
    resource.slotState === 'reserved' ? 'allow_candidate_write_only' : 'deny';
}
