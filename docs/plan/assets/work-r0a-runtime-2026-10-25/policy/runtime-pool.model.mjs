// F0-R6 设计模型：只在"已验真的本地/服务端事实"上做准入、回收与 drain 判定。
// 不实现 cgroup/rlimit/kill/Temporal/Kubernetes，也不证明任何资源限额或隔离真实生效。

export function podMemoryBudgetMiB(policy) {
  const { maxChildrenPerPod } = policy.concurrency;
  const { memoryMiB, scratchMiB, scratchCountsAgainstPodMemory } = policy.perChildBudget;
  const perChild = memoryMiB + (scratchCountsAgainstPodMemory ? scratchMiB : 0);
  return policy.podBudget.parentReserveMemoryMiB + policy.podBudget.overheadMemoryMiB + maxChildrenPerPod * perChild;
}

export function effectiveMaxChildren(policy, node) {
  if (policy.concurrency.cgroupSubtreeDelegationRequired && node.cgroupDelegation !== true) {
    return policy.concurrency.maxChildrenWithoutCgroupDelegation;
  }
  return policy.concurrency.maxChildrenPerPod;
}

export function podLimitSufficient(policy, podMemoryLimitMiB) {
  return Number.isSafeInteger(podMemoryLimitMiB) && podMemoryLimitMiB >= podMemoryBudgetMiB(policy);
}

function deny(code) {
  return { admit: false, code, stage: 'before_claim' };
}

// node: 已观测的本机状态；request: 片段调度请求（尚未 claim_runtime_execution）。
export function admissionDecision(policy, node, request) {
  if (request.alreadyClaimed === true) return deny('claim_before_admission_forbidden');
  if (node.draining === true) return deny('pool_draining');
  if (!podLimitSufficient(policy, node.podMemoryLimitMiB)) return deny('pod_budget_insufficient');

  const limit = effectiveMaxChildren(policy, node);
  if (!Number.isSafeInteger(node.runningChildren) || node.runningChildren < 0) return deny('unknown_local_state');
  if (node.runningChildren >= limit) return deny('pool_at_capacity');

  const child = policy.perChildBudget;
  if (node.freeMemoryMiB < child.memoryMiB) return deny('insufficient_memory');
  if (node.freeScratchMiB < child.scratchMiB) return deny('insufficient_scratch');
  if (node.runtimeVersion !== request.runtimeVersion) return deny('runtime_version_mismatch');
  if (request.checkpointRuntimeVersion != null && request.checkpointRuntimeVersion !== node.runtimeVersion) {
    return deny('incompatible_checkpoint_version');
  }
  if (!Number.isSafeInteger(request.remainingBudgetMs)) return deny('unknown_local_state');
  if (request.remainingBudgetMs < child.startBudgetMs + child.cancelGraceMs) return deny('insufficient_time_budget');

  return { admit: true, code: 'admit', stage: 'before_claim' };
}

// 本地回收计划：本地动作与外部真相分开，回收不产生 not_sent 结论。
export function reclaimPlan(policy, child) {
  const localActions = ['send_cancel_frame'];
  if (policy.reclamation.forceKillAfterCancelGrace) localActions.push('force_kill_after_grace');
  localActions.push('close_private_pipes', 'remove_execution_scratch', 'release_local_slot');

  const fragmentResult = child.gateConsumed === true ? 'WAITING_RECONCILE' : 'FAILED';
  const external = child.gateConsumed === true
    ? 'unknown_requires_reconcile'
    : 'requires_seal_to_prove_not_sent';
  const reason = child.cause === 'memory_exhausted' ? 'resource_exhausted' : child.cause;

  return {
    localActions,
    fragmentResult,
    externalState: external,
    reasonCode: reason,
    provesNotSent: false,
    reusesOldPermit: false,
  };
}

export function parentLossConsequence(policy, observation) {
  return {
    childSelfTerminates: policy.reclamation.childDiesWithParent === true,
    orphanCanObtainNewAuthorization: false,
    recoverFromLocalResidue: policy.reclamation.restartFromLocalResidue === true,
    resolution: observation.heartbeatTimedOut === true
      ? 'go_revoke_then_reconcile'
      : 'await_heartbeat_timeout',
    sameExecutionRestart: false,
  };
}

export function drainDecision(policy, state) {
  const window = policy.drain.awaitInFlightMs;
  const graceMs = policy.podBudget.terminationGracePeriodSeconds * 1000;
  const base = {
    acceptNewFragments: false,
    stopPollingFirst: policy.drain.stopPollingFirst === true,
    allowRenew: policy.drain.allowRenewDuringDrain === true,
    hardKillRisk: graceMs < window,
  };
  if (state.inFlightChildren === 0) return { ...base, action: 'exit' };
  if (state.elapsedMs < window) return { ...base, action: 'await_in_flight' };
  return { ...base, action: 'cancel_in_flight_then_reconcile' };
}

export function lateRequestAllowed(_policy, request) {
  return request.staleHolder !== true
    && request.staleGeneration !== true
    && request.staleExecution !== true
    && request.lateActivityResult !== true;
}

export function requiresPerRunPod(policy, context) {
  return policy.upgrade.perRunPodHardGates.some((gate) => context[gate] === true);
}
