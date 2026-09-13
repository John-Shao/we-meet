import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ApiError } from '@/api/ApiError'
import { fetchApi } from '@/api/fetchApi'
import { Button, Text } from '@/primitives'
import { css } from '@/styled-system/css'

import {
  CapturePayload,
  CaptureState,
  isCapturePayload,
  isCaptureReceipt,
  isCaptureSource,
  isCaptureState,
} from '../api/ApiOnlineCapture'
import { SummaryIntent, useSummaryIntent } from '../hooks/useSummaryIntent'

interface Props {
  roomId: string
  sid: string
  viewerId: string
}
export const OnlineCaptureControl = (props: Props) => (
  <OnlineCaptureWorkspace
    key={JSON.stringify([props.viewerId, props.roomId, props.sid])}
    {...props}
  />
)

const OnlineCaptureWorkspace = ({ roomId, sid, viewerId }: Props) => {
  const { t } = useTranslation('meetings')
  const client = useQueryClient()
  const path = 'online-captures/control/'
  const queryKey = [
    'meeting-records',
    viewerId,
    'online-capture',
    roomId,
    sid,
    path,
  ]
  const validate = useCallback(
    (value: unknown): value is CapturePayload =>
      isCapturePayload(value, roomId, sid),
    [roomId, sid]
  )
  const recovery = useSummaryIntent(
    'online-capture',
    viewerId,
    JSON.stringify([roomId, sid]),
    validate
  )
  const pending = recovery.pending
  const state = useQuery<CaptureState, ApiError>({
    queryKey,
    enabled: !!viewerId && isCaptureSource(roomId, sid),
    queryFn: async ({ signal }) => {
      const value = await fetchApi<unknown>(
        `${path}?${new URLSearchParams({ room_id: roomId, livekit_room_sid: sid })}`,
        {
          signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
          cache: 'no-store',
          redirect: 'error',
        }
      )
      if (!isCaptureState(value)) throw new Error('invalid_capture_state')
      return value
    },
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchInterval: 5000,
  })
  const [error, setError] = useState(false)
  const busy = useRef(false)
  const mutation = useMutation({
    mutationFn: async (intent: SummaryIntent<CapturePayload>) => {
      const value = await fetchApi<unknown>(path, {
        method: 'POST',
        body: JSON.stringify({ ...intent.payload, key: intent.key }),
        signal: AbortSignal.timeout(20000),
        cache: 'no-store',
        redirect: 'error',
      })
      if (!isCaptureReceipt(value, intent.payload))
        throw new Error('invalid_capture_receipt')
      return value
    },
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
      !recovery.ready ||
      (!pending && (!state.data?.can_control || state.isError))
    )
      return
    busy.current = true
    let intent: SummaryIntent<CapturePayload> | undefined
    setError(false)
    try {
      intent = recovery.getOrCreate(
        pending?.payload ?? {
          room_id: roomId,
          livekit_room_sid: sid,
          operation: active ? 'stop' : 'start',
          expected_run_id: current?.id ?? null,
        }
      )
      await mutation.mutateAsync(intent)
      if (!recovery.resolve(intent))
        throw new Error('capture_receipt_storage_failed')
      await client.invalidateQueries({
        queryKey: ['meeting-records', viewerId],
      })
    } catch (err) {
      if (
        err instanceof ApiError &&
        [400, 409, 422].includes(err.statusCode) &&
        intent
      )
        recovery.resolve(intent)
      setError(true)
      await state.refetch()
    } finally {
      busy.current = false
    }
  }
  if (state.isError && [401, 403, 404].includes(state.error.statusCode))
    return null
  if (recovery.failed)
    return (
      <section aria-label={t('recordAi.capture.title')}>
        <Text>{t('recordAi.recoveryError')}</Text>
        <Button size="sm" onPress={recovery.reload}>
          {t('recordAi.capture.refresh')}
        </Button>
      </section>
    )
  if (state.isError) {
    return (
      <section aria-label={t('recordAi.capture.title')}>
        <Text>
          {t(pending ? 'recordAi.uncertain' : 'recordAi.capture.unavailable')}
        </Text>
        {pending ? (
          <Button
            size="sm"
            isDisabled={mutation.isPending || !recovery.ready}
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
    (!pending && !current && (!state.data.available || !state.data.can_control))
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
                !recovery.ready ||
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
