import {
  ActivityFailure,
  ApplicationFailure,
  TimeoutFailure,
  condition,
  defineSignal,
  patched,
  proxyActivities,
  setHandler,
} from '@temporalio/workflow';

const normal = proxyActivities({
  startToCloseTimeout: '30 seconds',
  retry: { maximumAttempts: 3 },
});

// Model calls are never retried after dispatch; a stalled worker is detected by heartbeat timeout.
const model = proxyActivities({
  startToCloseTimeout: '30 seconds',
  heartbeatTimeout: '3 seconds',
  retry: { maximumAttempts: 1 },
});

const cancelSignal = defineSignal('cancel');
const resumeSignal = defineSignal('resume');

const SYSTEM_ACTOR = 'system:run-workflow';
const REASON_CODE = /^[a-z][a-z0-9_]{1,63}$/;
const TERMINAL_RUN_STATES = ['succeeded', 'failed', 'canceled'];

function reasonCode(reason) {
  return typeof reason === 'string' && REASON_CODE.test(reason) ? reason : 'user_requested';
}

function failureType(error) {
  const cause = error instanceof ActivityFailure ? error.cause : error;
  if (cause instanceof TimeoutFailure) return 'timeout';
  if (cause instanceof ApplicationFailure) return cause.type ?? 'application';
  return error?.type ?? error?.cause?.type ?? 'unknown';
}

// Any failure after a dispatch permit means the provider may have run: never treat it as not-sent.
function unknownReason(error) {
  switch (failureType(error)) {
    case 'ProviderUnknownError':
      return 'provider_no_receipt';
    case 'SimulatedCrash':
      return 'worker_crash_after_claim';
    case 'timeout':
      return 'activity_timeout';
    default:
      return 'dispatch_outcome_unknown';
  }
}

export async function RunWorkflow(input) {
  let cancelRequested = false;
  let cancelReason = null;
  let resumeRequested = false;
  const v2Behavior = patched('r0a-v2');
  setHandler(cancelSignal, (reason) => {
    cancelRequested = true;
    cancelReason = reason ?? null;
  });
  setHandler(resumeSignal, () => {
    resumeRequested = true;
  });

  const finishCanceled = (reason) =>
    normal.finishRun({ runId: input.runId, orgId: input.orgId, outcome: 'canceled', reason });

  await normal.prepareRun(input);
  const acquired = await normal.acquireRun(input.runId, input.orgId);
  if (acquired.state === 'cancel_requested') {
    await finishCanceled(reasonCode(cancelReason));
    return { status: 'canceled', phase: 'before_start' };
  }
  if (TERMINAL_RUN_STATES.includes(acquired.state)) {
    return { status: acquired.state, phase: 'already_terminal' };
  }

  const operation = await normal.createModelOperation(
    input.runId,
    input.orgId,
    'model:1',
    'sha256:model-1',
  );
  await normal.authorizeOperation(operation.operationId, input.orgId, 1);
  const reservation = await normal.reserveBudget(input.orgId, operation.operationId);
  if ((input.faultMode ?? 'none') === 'hold_before_claim') {
    await condition(() => resumeRequested || cancelRequested);
  }
  if (cancelRequested) {
    const reason = reasonCode(cancelReason);
    await normal.cancelOperation(operation.operationId, input.orgId, SYSTEM_ACTOR, reason);
    await finishCanceled(reason);
    return { status: 'canceled', phase: 'before_dispatch' };
  }

  const permit = await normal.claimDispatch(operation.operationId, input.orgId, acquired.fence);
  if (!permit) {
    const state = await normal.inspectDispatch(operation.operationId, input.orgId);
    if (state?.operation_state === 'authorized' && state.run_state === 'cancel_requested') {
      await normal.cancelOperation(operation.operationId, input.orgId, SYSTEM_ACTOR, 'user_requested');
      await finishCanceled('user_requested');
      return { status: 'canceled', phase: 'before_dispatch' };
    }
    // Owned by another dispatcher or no longer current: its outcome belongs to that owner/reconciler.
    return {
      status: 'not_dispatched',
      operationState: state?.operation_state ?? null,
      runState: state?.run_state ?? null,
    };
  }

  const modelOutcome = model
    .invokeModel({
      runId: input.runId,
      taskId: input.taskId,
      orgId: input.orgId,
      operationId: operation.operationId,
      dispatchAttemptId: permit,
      fence: acquired.fence,
      requestHash: 'sha256:model-1',
      faultMode: input.faultMode ?? 'none',
    })
    .then(
      (result) => ({ kind: 'model', result }),
      (error) => ({ kind: 'error', error }),
    );
  const cancelOutcome = condition(() => cancelRequested).then(() => ({ kind: 'cancel' }));
  const outcome = await Promise.race([modelOutcome, cancelOutcome]);

  if (outcome.kind === 'cancel') {
    const reason = reasonCode(cancelReason);
    // Dispatching → unknown with the hold kept; the run closes now, billing follows the late result.
    await normal.cancelOperation(operation.operationId, input.orgId, SYSTEM_ACTOR, reason);
    await finishCanceled(reason);
    const late = await modelOutcome;
    if (late.kind === 'model') {
      await normal.reconcileLateResult(
        input.orgId,
        operation.operationId,
        late.result.providerRequestId,
        late.result.billableCents,
        `receipt-${input.runId}`,
      );
      return { status: 'canceled', phase: 'during_dispatch', lateResult: 'billed' };
    }
    return { status: 'canceled', phase: 'during_dispatch', lateResult: 'unknown' };
  }

  if (outcome.kind === 'error') {
    const reason = unknownReason(outcome.error);
    await normal.markOperationUnknown(operation.operationId, input.orgId, reason);
    const runState = await normal.getRunState(input.runId, input.orgId);
    if (cancelRequested || runState === 'cancel_requested') {
      await finishCanceled(reasonCode(cancelReason));
      return { status: 'canceled', phase: 'after_unknown', reason };
    }
    await normal.waitRun(input.runId, input.orgId, 'reconcile');
    return { status: 'unknown', reason };
  }

  const result = outcome.result;
  await normal.finishOperation(
    input.orgId,
    operation.operationId,
    'succeeded',
    result.providerRequestId,
    `receipt-${input.runId}`,
  );
  await normal.settleBudget(input.orgId, reservation.reservationId, result.billableCents, 'price-v1', result.usage, 1);
  if ((input.faultMode ?? 'none') === 'hold_before_publish') {
    await condition(() => resumeRequested || cancelRequested);
  }
  const runState = await normal.getRunState(input.runId, input.orgId);
  if (TERMINAL_RUN_STATES.includes(runState)) {
    // DB already closed the run (operator/terminal offset): usage is settled, nothing is published.
    return { status: 'superseded', runState };
  }
  if (cancelRequested || runState === 'cancel_requested') {
    await finishCanceled(reasonCode(cancelReason));
    return { status: 'canceled', phase: 'after_result' };
  }
  try {
    const artifact = await normal.publishArtifact(
      input.orgId,
      input.taskId,
      input.runId,
      v2Behavior ? 'draft-v2.md' : 'draft.md',
      result.contentRef,
      result.contentHash,
      result.bytes,
      'text/markdown',
      { source: 'faux' },
    );
    await normal.finishRun({
      runId: input.runId,
      orgId: input.orgId,
      outcome: 'succeeded',
      reason: null,
    });
    return { status: 'succeeded', artifact };
  } catch (error) {
    const type = failureType(error);
    if (type === 'run_not_accepting_artifacts' || type === 'run_cancel_requested') {
      const latest = await normal.getRunState(input.runId, input.orgId);
      if (latest === 'cancel_requested') {
        await finishCanceled('user_requested');
        return { status: 'canceled', phase: 'publish_refused' };
      }
      return { status: 'superseded', runState: latest };
    }
    throw error;
  }
}
