import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ApiError } from '@/api/ApiError'
import { fetchApi } from '@/api/fetchApi'
import { Button, Text } from '@/primitives'
import { css } from '@/styled-system/css'

interface CaptureRun {
  id: string
  record_id: string
  state: 'starting' | 'recording' | 'stopping' | 'stopped' | 'incomplete'
  error_code: string
}

interface CaptureState {
  available: boolean
  can_control: boolean
  current: CaptureRun | null
}

interface CaptureIntent {
  key: string
  room_id: string
  livekit_room_sid: string
  operation: 'start' | 'stop'
  expected_run_id: string | null
}

export const OnlineCaptureControl = ({
  roomId,
  sid,
  viewerId,
}: {
  roomId: string
  sid: string
  viewerId: string
}) => {
  const { t } = useTranslation('meetings')
  const client = useQueryClient()
  const path = 'online-captures/control/'
  const queryKey = ['meeting-records', viewerId, 'online-capture', roomId, sid, path]
  const state = useQuery<CaptureState, ApiError>({
    queryKey,
    queryFn: ({ signal }) =>
      fetchApi(
        `${path}?${new URLSearchParams({ room_id: roomId, livekit_room_sid: sid })}`,
        { signal }
      ),
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchInterval: 5000,
  })
  const [pending, setPending] = useState<CaptureIntent>()
  const [error, setError] = useState(false)
  const busy = useRef(false)
  const mutation = useMutation({
    mutationFn: (intent: CaptureIntent) =>
      fetchApi(path, { method: 'POST', body: JSON.stringify(intent) }),
    retry: false,
    gcTime: 0,
  })
  const current = state.data?.current
  const active =
    current?.state === 'starting' ||
    current?.state === 'recording' ||
    current?.state === 'stopping'
  const change = async () => {
    if (
      busy.current ||
      (!pending && (!state.data?.can_control || state.isError))
    )
      return
    busy.current = true
    const intent: CaptureIntent = pending ?? {
      key: crypto.randomUUID(),
      room_id: roomId,
      livekit_room_sid: sid,
      operation: active ? 'stop' : 'start',
      expected_run_id: current?.id ?? null,
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
  if (state.isError) {
    if (state.error.statusCode === 404 || state.error.statusCode === 403)
      return null
    return (
      <section aria-label={t('recordAi.capture.title')}>
        <Text>
          {t(pending ? 'recordAi.uncertain' : 'recordAi.capture.unavailable')}
        </Text>
        {pending ? (
          <Button
            size="sm"
            isDisabled={mutation.isPending}
            onPress={() => void change()}
          >
            {t('recordAi.resubmit')}
          </Button>
        ) : (
          <Button size="sm" onPress={() => void state.refetch()}>
            {t('recordAi.capture.refresh')}
          </Button>
        )}
      </section>
    )
  }
  if (
    !state.data ||
    (!current && (!state.data.available || !state.data.can_control))
  )
    return null
  return (
    <section
      aria-label={t('recordAi.capture.title')}
      className={css({
        padding: '1rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.5rem',
      })}
    >
      <Text>{t(`recordAi.capture.state.${current?.state ?? 'off'}`)}</Text>
      {state.data.can_control && (
        <>
          <Text variant="note">{t('recordAi.capture.description')}</Text>
          {(active || state.data.available || pending) && (
            <Button
              size="sm"
              variant="tertiary"
              isDisabled={
                mutation.isPending ||
                (!pending && current?.state === 'stopping')
              }
              onPress={() => void change()}
            >
              {t(
                pending
                  ? 'recordAi.resubmit'
                  : active
                    ? 'recordAi.capture.stop'
                    : 'recordAi.capture.start'
              )}
            </Button>
          )}
        </>
      )}
      {current?.state === 'incomplete' && (
        <Text variant="note">{t('recordAi.capture.incompleteHint')}</Text>
      )}
      {error && (
        <div role="status">
          {t(pending ? 'recordAi.uncertain' : 'recordAi.capture.conflict')}
        </div>
      )}
    </section>
  )
}
