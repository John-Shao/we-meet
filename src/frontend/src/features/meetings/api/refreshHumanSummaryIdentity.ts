import type { QueryClient } from '@tanstack/react-query'

/** Call only after the identity operation's authenticated session is rechecked. */
export const refreshHumanSummaryIdentity = (
  client: QueryClient,
  viewerId: string,
  recordId: string
) =>
  Promise.all([
    client.invalidateQueries({
      queryKey: ['human-summary', viewerId, recordId],
    }),
    client.invalidateQueries({ queryKey: ['human-summary-history', viewerId] }),
    client.invalidateQueries({
      queryKey: ['human-summary-history-detail', viewerId],
    }),
  ])
