// Host 接入合同设计模型：判定会话验真、权威组织发现、投影同步与失效语义。
// 不实现 HTTP/mTLS/SQL，也不证明真实 Host 已提供任何字段。

export function adapterCallAllowed(contract, caller) {
  if (contract.adapter.forbiddenCallers.includes(caller.role)) return { allowed: false, reason: 'caller_not_permitted' };
  if (!contract.adapter.callableFrom.includes(caller.role)) return { allowed: false, reason: 'caller_not_permitted' };
  if (caller.identityVerified !== true) return { allowed: false, reason: 'service_identity_unverified' };
  return { allowed: true, role: contract.adapter.databaseRole, writesTables: contract.adapter.writesTablesDirectly };
}

export function sessionDecision(contract, verification) {
  const rules = contract.sessionVerification;
  if (verification.hostAvailable !== true) {
    return { allow: false, code: 'session_unverifiable', failClosed: rules.failClosed };
  }
  if (verification.verified !== true) return { allow: false, code: 'session_invalid' };
  if (verification.revoked === true) return { allow: false, code: 'session_revoked' };
  if (!Number.isSafeInteger(verification.ageSeconds) || verification.ageSeconds < 0) {
    return { allow: false, code: 'session_invalid' };
  }
  if (verification.ageSeconds > rules.maxAcceptedAgeSeconds) {
    return { allow: false, code: 'session_stale' };
  }
  for (const field of rules.returnedFields) {
    if (verification.claims?.[field] == null) return { allow: false, code: 'host_field_gap', field };
  }
  return { allow: true, subjectId: verification.claims.subject_id, orgId: verification.claims.org_id };
}

export function resolveOrg(contract, request, session) {
  if (request.orgId != null && request.orgId !== session.orgId) {
    return contract.orgDiscovery.clientSelectedOrgAccepted
      ? { orgId: request.orgId }
      : { orgId: null, code: 'org_not_found' };
  }
  if (session.orgId == null) return { orgId: null, code: 'org_not_found' };
  return { orgId: session.orgId, authoritative: contract.orgDiscovery.authoritative };
}

export function entitlementSource(contract, context) {
  const stale = context.projectionStale === true && contract.authoritativeReads.staleProjectionBlocksNewWork;
  return {
    source: contract.authoritativeReads.requestPathSource,
    hostInRequestPath: contract.authoritativeReads.hostInRequestPathForEntitlement,
    readsAllowed: contract.failureSemantics.hostUnavailableAllowsReadsFromProjection || context.hostAvailable === true,
    newWorkAllowed: !stale,
  };
}

export function syncDecision(contract, current, incoming) {
  if (incoming.mode === 'full' && contract.sync.fullSnapshotMayDeleteRows === false && incoming.deleteRows === true) {
    return { apply: false, code: 'delete_not_permitted' };
  }
  if (!Number.isSafeInteger(incoming.revision) || incoming.revision < 0) return { apply: false, code: 'revision_invalid' };
  if (current != null) {
    if (incoming.revision < current.revision) return { apply: false, code: 'revision_stale' };
    if (incoming.revision === current.revision) {
      return incoming.factsHash === current.factsHash
        ? { apply: false, code: 'noop_replay' }
        : { apply: false, code: 'revision_conflict' };
    }
    if (current.operatorSuspended === true && incoming.facts?.status === 'active' && !contract.sync.operatorSuspendedOverridable) {
      return { apply: false, code: 'operator_suspended_preserved' };
    }
  }
  const effect = {
    apply: true,
    writesVia: contract.adapter.domainCommands,
    cancelsRuns: contract.sync.syncMayCancelRuns,
    cancelHandledBy: contract.sync.cancelHandledBy,
  };
  if (incoming.mode === 'full' && incoming.absentFromSnapshot === true) {
    effect.narrowTo = contract.sync.absentInFullSnapshot;
  }
  return effect;
}

export function hostPayloadAccepted(contract, port, payload) {
  const declared = {
    IdentityDirectory: ['org_id', 'name', 'status', 'home_region', 'revision'],
    Entitlement: ['subject_id', 'work_seat', 'status', 'revision'],
    Notification: ['delivered', 'channel'],
    BillingExport: ['accepted', 'statement_id'],
  }[port];
  if (declared == null) return { accepted: false, reason: 'unknown_port' };
  for (const key of Object.keys(payload)) {
    if (!declared.includes(key)) return { accepted: false, reason: 'unexpected_field', field: key };
  }
  for (const field of declared) {
    if (!Object.hasOwn(payload, field)) {
      return { accepted: false, reason: 'host_field_gap', field, guessed: contract.failureSemantics.missingFieldIsGapNotGuess === false };
    }
  }
  return { accepted: true };
}
