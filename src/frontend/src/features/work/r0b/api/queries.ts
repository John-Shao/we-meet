import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import {
  fetchWorkLocalPolicy,
  fetchWorkReadonlyGrants,
  fetchWorkRunHistoryHandback,
  fetchWorkRunReconciliations,
  fetchWorkRunSupersedeBudgets,
  revokeWorkReadonlyGrant,
  setWorkLocalPolicy,
} from './client'
import { useWorkBootstrap } from '../../r0a/api/queries'
import type { PendingLocalApproval } from '../../localBridgeTypes'

const r0bKeys = {
  reconciliations: (runId: string) =>
    ['work', 'r0b', 'reconciliations', runId] as const,
  handback: (runId: string) =>
    ['work', 'r0b', 'history-handback', runId] as const,
  supersedeBudgets: (runId: string) =>
    ['work', 'r0b', 'supersede-budgets', runId] as const,
  localPolicy: ['work', 'r0b', 'local-policy'] as const,
  readonlyGrants: (runId: string) =>
    ['work', 'r0b', 'readonly-grants', runId] as const,
  pendingApprovals: ['work', 'r0b', 'pending-approvals'] as const,
}

/**
 * J16/R12C-2's "what is this waiting on" read. The task page invalidates the
 * `['work','r0b']` prefix when an SSE event arrives, so this projection follows the
 * same events as the run ledger instead of polling.
 */
export const useWorkRunReconciliations = (
  runId: string | undefined,
  enabled: boolean
) =>
  useQuery({
    queryKey: r0bKeys.reconciliations(runId ?? ''),
    queryFn: () => fetchWorkRunReconciliations(runId!),
    enabled: enabled && !!runId,
    staleTime: 10_000,
    retry: false,
  })

export const useWorkRunSupersedeBudgets = (
  runId: string | undefined,
  enabled: boolean
) =>
  useQuery({
    queryKey: r0bKeys.supersedeBudgets(runId ?? ''),
    queryFn: () => fetchWorkRunSupersedeBudgets(runId!),
    enabled: enabled && !!runId,
    staleTime: 10_000,
    retry: false,
  })

/**
 * device-design §3.3's display fact for one run: is it handing its history back and wrapping up.
 *
 * Asked only while the run is `active`, because 0059's mint requires exactly that state — a run in
 * `waiting`/`queued`/terminal can have no live `reconcile_finish` lease, so the question would
 * always answer false and the read would be pure traffic. The 15s refresh is not a poll for its own
 * sake: §3.3 fixes the device heartbeat at 10s and the lease TTL at 30s, so re-reading within one
 * TTL is what keeps the sentence from outliving the hand-back it describes. A failure reads as "not
 * handing back" (retry false) rather than as a stuck-task copy, which is the safer of the two
 * wrong answers the UI can give.
 */
export const useWorkRunHistoryHandback = (
  runId: string | undefined,
  runState: string | undefined
) =>
  useQuery({
    queryKey: r0bKeys.handback(runId ?? ''),
    queryFn: () => fetchWorkRunHistoryHandback(runId!),
    enabled: !!runId && runState === 'active',
    staleTime: 5_000,
    refetchInterval: 15_000,
    retry: false,
  })

/**
 * §1.4's admin read face. The panel only mounts it when bootstrap advertises R0b, so an R0a
 * organization never issues a v2 request; the admin gate itself is server side
 * (get_local_policy asserts owner/admin).
 */
export const useWorkLocalPolicy = () =>
  useQuery({
    queryKey: r0bKeys.localPolicy,
    queryFn: fetchWorkLocalPolicy,
    staleTime: 10_000,
    retry: false,
  })

/** The PATCH answer is the row as the server now holds it, so it seeds the cache directly. */
export const useSetWorkLocalPolicy = () => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: setWorkLocalPolicy,
    onSuccess: (policy) => {
      queryClient.setQueryData(r0bKeys.localPolicy, policy)
    },
  })
}

/** The owner's own grants for one run; expired and revoked rows are part of the answer. */
export const useWorkReadonlyGrants = (
  runId: string | undefined,
  enabled: boolean
) =>
  useQuery({
    queryKey: r0bKeys.readonlyGrants(runId ?? ''),
    queryFn: () => fetchWorkReadonlyGrants(runId),
    enabled: enabled && !!runId,
    staleTime: 10_000,
    retry: false,
  })

export const useWorkPendingLocalApprovals = (
  taskId: string | undefined,
  enabled: boolean
) => {
  const bootstrapQ = useWorkBootstrap()
  return useQuery({
    queryKey: r0bKeys.pendingApprovals,
    queryFn: async (): Promise<PendingLocalApproval[]> => {
      const bridge = window.weMeetDesktop?.work
      if (!bridge?.listPendingLocalApprovals) return []
      const result = await bridge.listPendingLocalApprovals()
      if (result.status !== 'available') return []
      return result.approvals
    },
    enabled:
      enabled &&
      !!taskId &&
      !!window.weMeetDesktop?.work?.listPendingLocalApprovals &&
      !!bootstrapQ.data?.phases.includes('R0b'),
    staleTime: 5_000,
    refetchInterval: 15_000,
    retry: false,
  })
}

export const useRevokeWorkReadonlyGrant = () => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({
      grantId,
      body,
    }: {
      grantId: string
      body: { client_request_id: string; expected_revision: number }
    }) => revokeWorkReadonlyGrant(grantId, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ['work', 'r0b', 'readonly-grants'],
      })
    },
  })
}
