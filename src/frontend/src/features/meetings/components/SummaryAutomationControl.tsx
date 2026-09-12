import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ApiError } from '@/api/ApiError'
import { fetchApi } from '@/api/fetchApi'
import { Button, Text } from '@/primitives'

interface Automation {
  revision: number
  enabled: boolean
  available: boolean
  can_control: boolean
  state: 'off' | 'waiting' | 'generating' | 'completed' | 'needs_attention'
  error_code: string
}

export const SummaryAutomationControl = ({
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
    queryKey: ['meeting-records', viewerId, 'summary-automation', recordId, path],
    queryFn: ({ signal }) => fetchApi(path, { signal }),
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchInterval: (query) =>
      query.state.status === 'error' ? false : 10000,
  })
  const [pending, setPending] = useState<{
    key: string
    body: { enabled: boolean; expected_revision: number }
  }>()
  const [error, setError] = useState(false)
  const busy = useRef(false)
  const mutation = useMutation({
    mutationFn: (intent: NonNullable<typeof pending>) =>
      fetchApi(path, {
        method: 'POST',
        headers: { 'Idempotency-Key': intent.key },
        body: JSON.stringify(intent.body),
      }),
    retry: false,
    gcTime: 0,
  })
  const change = async () => {
    if (busy.current || !state.data) return
    busy.current = true
    const intent = pending ?? {
      key: crypto.randomUUID(),
      body: {
        enabled: !state.data.enabled,
        expected_revision: state.data.revision,
      },
    }
    setPending(intent)
    setError(false)
    try {
      await mutation.mutateAsync(intent)
      setPending(undefined)
      await client.invalidateQueries({
        queryKey: ['meeting-records', viewerId],
      })
    } catch (err) {
      if (
        err instanceof ApiError &&
        err.statusCode < 500 &&
        err.statusCode !== 429
      )
        setPending(undefined)
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
    (!state.data.available && !state.data.enabled)
  )
    return null
  return (
    <section aria-label={t('recordAi.automation.title')}>
      <Text>{t(`recordAi.automation.state.${state.data.state}`)}</Text>
      <Text variant="note">{t('recordAi.automation.description')}</Text>
      <Button
        size="sm"
        variant="tertiary"
        isDisabled={mutation.isPending}
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
        <div role="status">
          {t(pending ? 'recordAi.uncertain' : 'recordAi.conflict')}
        </div>
      )}
    </section>
  )
}
