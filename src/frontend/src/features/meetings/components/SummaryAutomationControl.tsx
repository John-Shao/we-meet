import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRef, useState, type ComponentProps } from 'react'
import { useTranslation } from 'react-i18next'

import { ApiError } from '@/api/ApiError'
import { fetchApi } from '@/api/fetchApi'
import { Button, Text } from '@/primitives'
import { automationReceipt } from '../api/summaryReceipts'
import {
  isAutomationPayload,
  useSummaryIntent,
} from '../hooks/useSummaryIntent'

interface Automation {
  revision: number
  enabled: boolean
  available: boolean
  can_control: boolean
  state: 'off' | 'waiting' | 'generating' | 'completed' | 'needs_attention'
  error_code: string
}

export const SummaryAutomationControl = (
  props: ComponentProps<typeof SummaryAutomationContent>
) => (
  <SummaryAutomationContent
    key={JSON.stringify([props.viewerId, props.recordId])}
    {...props}
  />
)

const SummaryAutomationContent = ({
  recordId,
  viewerId,
}: {
  recordId: string
  viewerId: string
}) => {
  const { t } = useTranslation('meetings')
  const client = useQueryClient()
  const path = `meeting-records/${encodeURIComponent(recordId)}/summary-automation/`
  const state = useQuery<Automation, ApiError>({
    queryKey: [
      'meeting-records',
      viewerId,
      'summary-automation',
      recordId,
      path,
    ],
    queryFn: ({ signal }) => fetchApi(path, { signal }),
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchInterval: (query) =>
      query.state.status === 'error' ? false : 10000,
  })
  const recovery = useSummaryIntent(
    'automation',
    viewerId,
    recordId,
    isAutomationPayload
  )
  const pending = recovery.pending
  const [error, setError] = useState(false)
  const busy = useRef(false)
  const mutation = useMutation({
    mutationFn: async (intent: NonNullable<typeof pending>) =>
      automationReceipt(
        await fetchApi<unknown>(path, {
          method: 'POST',
          headers: { 'Idempotency-Key': intent.key },
          body: JSON.stringify(intent.payload),
          cache: 'no-store',
          redirect: 'error',
          signal: AbortSignal.timeout(20000),
        }),
        intent.payload
      ),
    retry: false,
    gcTime: 0,
  })
  const change = async () => {
    if (busy.current || !state.data || !recovery.ready) return
    busy.current = true
    setError(false)
    let intent: NonNullable<typeof pending>
    try {
      intent = recovery.getOrCreate({
        enabled: !state.data.enabled,
        expected_revision: state.data.revision,
      })
    } catch {
      busy.current = false
      return
    }
    try {
      await mutation.mutateAsync(intent)
      recovery.resolve(intent)
      await client.invalidateQueries({
        queryKey: ['meeting-records', viewerId],
      })
    } catch (err) {
      if (
        err instanceof ApiError &&
        [400, 401, 403, 404, 409, 422].includes(err.statusCode)
      )
        recovery.resolve(intent)
      setError(true)
      await state.refetch()
    } finally {
      busy.current = false
    }
  }
  // Old backends and disabled rollout do not add an unavailable feature entry.
  if (
    state.isError ||
    !state.data ||
    !state.data.can_control ||
    (!state.data.available && !state.data.enabled && !pending && recovery.ready)
  )
    return null
  return (
    <section aria-label={t('recordAi.automation.title')}>
      <Text>{t(`recordAi.automation.state.${state.data.state}`)}</Text>
      <Text variant="note">{t('recordAi.automation.description')}</Text>
      <Button
        size="sm"
        variant="tertiary"
        loading={mutation.isPending}
        isDisabled={mutation.isPending || !recovery.ready}
        onPress={() => void change()}
      >
        {t(
          pending
            ? 'recordAi.resubmit'
            : state.data.enabled
              ? 'recordAi.automation.stop'
              : 'recordAi.automation.start'
        )}
      </Button>
      {error && (
        <div role="alert">
          {t(pending ? 'recordAi.uncertain' : 'recordAi.conflict')}
        </div>
      )}
      {recovery.failed && (
        <div role="alert">
          <Text>{t('recordAi.recoveryError')}</Text>
          <Button size="sm" variant="tertiary" onPress={recovery.reload}>
            {t('recordAi.refresh')}
          </Button>
        </div>
      )}
    </section>
  )
}
