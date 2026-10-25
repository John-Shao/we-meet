import {
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

// Model calls must never be retried after dispatch.
const model = proxyActivities({
  startToCloseTimeout: '30 seconds',
  heartbeatTimeout: '10 seconds',
  retry: { maximumAttempts: 1 },
});

const cancelSignal = defineSignal('cancel');
const resumeSignal = defineSignal('resume');

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

  const prepared = await normal.prepareRun(input);
  const acquired = await normal.acquireRun(input.runId, input.orgId);
  const operation = await normal.createModelOperation(
    input.runId,
    input.orgId,
    'model:1',
    'sha256:model-1',
  );
  await normal.authorizeOperation(operation.operationId, input.orgId, 1);
  const reservation = await normal.reserveBudget(input.orgId, operation.operationId);
  const permit = await normal.claimDispatch(operation.operationId, input.orgId, acquired.fence);

  if (!permit) {
    await normal.markOperationUnknown(operation.operationId, input.orgId, 'dispatch_not_won');
    await normal.waitRun(input.runId, input.orgId, 'reconcile');
    return { status: 'unknown', reason: 'dispatch_not_won' };
  }

  const modelPromise = model.invokeModel({
    runId: input.runId,
    taskId: input.taskId,
    orgId: input.orgId,
    operationId: operation.operationId,
    dispatchAttemptId: permit,
    fence: prepared.fence ?? acquired.fence,
    requestHash: 'sha256:model-1',
    faultMode: input.faultMode ?? 'none',
  });
  const modelOutcome = modelPromise
    .then((result) => ({ kind: 'model', result }))
    .catch((error) => ({ kind: 'error', error }));
  const cancelOutcome = condition(() => cancelRequested).then(() => ({ kind: 'cancel' }));
  const outcome = await Promise.race([modelOutcome, cancelOutcome]);

  if (outcome.kind === 'cancel') {
    await normal.cancelOperation(operation.operationId, input.orgId, 'user1', cancelReason);
    await normal.finishRun({
      runId: input.runId,
      orgId: input.orgId,
      outcome: 'canceled',
      reason: 'user canceled',
    });
    return { status: 'canceled' };
  }

  if (outcome.kind === 'error') {
    const type =
      outcome.error?.type ?? outcome.error?.cause?.type ?? 'UnknownActivityError';
    if (type === 'ProviderUnknownError' || type === 'SimulatedCrash') {
      await normal.markOperationUnknown(operation.operationId, input.orgId, type);
      await normal.waitRun(input.runId, input.orgId, 'reconcile');
      return { status: 'unknown', reason: type };
    }
    throw outcome.error;
  }

  const result = outcome.result;
  await normal.finishOperation(
    input.orgId,
    operation.operationId,
    'succeeded',
    result.providerRequestId,
    `receipt-${input.runId}`,
  );
  await normal.settleBudget(reservation.reservationId, 80, 'price-v1', result.usage, 1);
  if ((input.faultMode ?? 'none') === 'hold_before_publish') {
    await condition(() => resumeRequested);
  }
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
}
