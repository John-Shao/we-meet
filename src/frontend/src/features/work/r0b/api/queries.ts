import { useQuery } from '@tanstack/react-query'

import { fetchWorkRunReconciliations } from './client'

const r0bKeys = {
  reconciliations: (runId: string) =>
    ['work', 'r0b', 'reconciliations', runId] as const,
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