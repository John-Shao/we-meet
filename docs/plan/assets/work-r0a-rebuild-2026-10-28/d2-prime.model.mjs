// D2' 设计模型：只在"已验真的服务端事实"上判定公开契约语义。
// 不实现 HTTP、SQL、会话或 codegen，也不证明任何实际端点存在。

export function requestIdentity(surface, request) {
  for (const field of surface.identity.rejectedBodyFields) {
    if (request.body != null && Object.hasOwn(request.body, field)) {
      return { ok: false, status: 400, code: 'identity_from_server_only', field };
    }
  }
  if (request.session == null || request.session.verified !== true) {
    return { ok: false, status: 401, code: 'session_invalid' };
  }
  if (surface.session.csrfRequiredForMutations && request.mutating === true) {
    if (request.headers?.[surface.session.csrfHeader] !== request.session.csrfToken) {
      return { ok: false, status: 403, code: 'csrf_invalid', recovery_action: 'refresh_csrf' };
    }
  }
  return {
    ok: true,
    orgId: request.session.orgId,
    subjectId: request.session.subjectId,
    assertedBy: surface.identity.sessionAssertedInDatabase,
  };
}

export function idempotencyOutcome(surface, stored, incoming) {
  if (typeof incoming.clientRequestId !== 'string' || incoming.clientRequestId.length === 0) {
    return { outcome: 'reject', status: 422, code: 'client_request_id_required' };
  }
  if (stored == null) return { outcome: 'execute', scope: surface.idempotency.scope };
  const sameScope = surface.idempotency.scope.every((key) => stored.scope[key] === incoming.scope[key]);
  if (!sameScope) return { outcome: 'execute', scope: surface.idempotency.scope };
  if (stored.payloadHash === incoming.payloadHash) return { outcome: 'replay', status: stored.status };
  return { outcome: 'reject', status: 409, code: surface.idempotency.sameKeyDifferentPayload };
}

export function paginationRequest(surface, params) {
  if (Object.hasOwn(params, 'offset') || Object.hasOwn(params, 'page')) {
    return { ok: false, status: 422, code: 'pagination_offset_unsupported' };
  }
  const { limit, cursor } = params;
  if (!Number.isSafeInteger(limit) || limit < surface.pagination.limitMin || limit > surface.pagination.limitMax) {
    return { ok: false, status: 422, code: 'pagination_limit_invalid' };
  }
  if (cursor !== undefined && typeof cursor !== 'string') {
    return { ok: false, status: 422, code: 'pagination_cursor_invalid' };
  }
  return { ok: true, style: surface.pagination.style, cursorType: surface.pagination.cursorType };
}

export function errorEnvelope(surface, raised) {
  const mapped = surface.errorMapping.order.reduce((acc, stage) => {
    if (acc != null) return acc;
    if (stage === 'db_exception_map') return raised.dbExceptionCode != null ? raised.publicCode ?? null : null;
    if (stage === 'public_code_catalog') return raised.publicCode ?? null;
    if (stage === 'sqlstate_fallback') return raised.sqlstateCode ?? null;
    return surface.errorMapping.unmappedInternalCode;
  }, null) ?? surface.errorMapping.unmappedInternalCode;

  const status = mapped === surface.errorMapping.unmappedInternalCode ? 503 : raised.status;
  const envelope = {
    code: mapped,
    status,
    retryable: surface.errorMapping.retryableOnlyForStatuses.includes(status),
    correlation_id: raised.correlationId,
  };
  if (surface.conflict.codesCarryingCurrentRevision.includes(mapped)) {
    if (!Number.isSafeInteger(raised.currentRevisionFromDetail)) {
      return { code: 'conflict_detail_missing', status: 503, retryable: true, correlation_id: raised.correlationId };
    }
    envelope.status = surface.conflict.status;
    envelope.retryable = false;
    envelope.current_revision = raised.currentRevisionFromDetail;
  }
  return envelope;
}

export function mediaTypeOutcome(surface, request) {
  if (request.transportContentType != null && request.transportContentType !== 'application/json') {
    return { status: surface.mediaType.transportMismatchStatus, code: surface.mediaType.transportMismatchCode };
  }
  if (request.declaredMediaType != null && !surface.mediaType.allowedArtifactMediaTypes.includes(request.declaredMediaType)) {
    return { status: surface.mediaType.declaredFieldInvalidStatus, code: surface.mediaType.declaredFieldInvalidCode };
  }
  return { status: 200, code: null };
}

export function snapshotShape(surface, snapshot) {
  const spec = surface.taskDetailSnapshot;
  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return { ok: false, reason: 'not_an_object' };
  }
  const keys = Object.keys(snapshot);
  for (const field of spec.requiredFields) {
    if (!keys.includes(field)) return { ok: false, reason: 'missing_field', field };
  }
  for (const key of keys) {
    if (spec.forbiddenFields.includes(key)) return { ok: false, reason: 'forbidden_field', field: key };
    if (spec.additionalProperties === false && !spec.requiredFields.includes(key)) {
      return { ok: false, reason: 'undeclared_field', field: key };
    }
  }
  return { ok: true };
}

export function publicProjection(surface, internalFacts) {
  const leaked = Object.keys(internalFacts).filter((key) => surface.runtimeExposure.forbiddenPublicFields.includes(key));
  if (leaked.length > 0) return { ok: false, reason: 'internal_field_exposed', fields: leaked };
  if (internalFacts.resultUnknown === true) {
    return { ok: true, display_state: surface.runtimeExposure.unknownResultDisplayState, acceptable: false };
  }
  return { ok: true, display_state: internalFacts.display_state, acceptable: internalFacts.display_state === 'awaiting_acceptance' };
}
