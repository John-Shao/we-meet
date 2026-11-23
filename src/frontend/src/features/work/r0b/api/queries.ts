import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import {
  fetchWorkLocalPolicy,
  fetchWorkRunReconciliations,
  setWorkLocalPolicy,
} from './client'

const r0bKeys = {
  reconciliations: (runId: string) =>
    ['work', 'r0b', 'reconciliations', runId] as const,
  localPolicy: ['work', 'r0b', 'local-policy'] as const,
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
