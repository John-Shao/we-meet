import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ApiError } from '@/api/ApiError'
import { fetchApi } from '@/api/fetchApi'
import { Button } from '@/primitives'
import { Checkbox } from '@/primitives/Checkbox'
import { css } from '@/styled-system/css'

export type PurgeReceipt = {
  id: string
  state: 'pending' | 'failed' | 'complete'
  expected_revision: number
  not_before: string
  completed_at: string | null
  can_retry: boolean
}
export type PurgeItem = {
  id: string
  title: string
  lifecycle_revision: number
  purge?: PurgeReceipt | null
}

function validate(value: PurgeReceipt, id: string, revision: number) {
  if (
    value.id !== id ||
    value.expected_revision !== revision ||
    !['pending', 'failed', 'complete'].includes(value.state) ||
    !Number.isFinite(Date.parse(value.not_before))
  )
    throw new Error('Unexpected deletion receipt')
  return value
}

export function RecordPurge({
  viewerId,
  item,
  onClose,
}: {
  viewerId: string
  item: PurgeItem
  onClose: () => void
}) {
  const { t } = useTranslation('meetings')
  const client = useQueryClient()
  const [accepted, setAccepted] = useState(Boolean(item.purge))
  const [acknowledged, setAcknowledged] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const inFlight = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const revision = item.purge?.expected_revision ?? item.lifecycle_revision
  const path = `meeting-records/${encodeURIComponent(item.id)}/purge/`
  const queryKey = ['record-purge', viewerId, item.id, revision, path]
  const query = useQuery({
    queryKey,
    queryFn: async ({ signal }) =>
      validate(
        await fetchApi<PurgeReceipt>(path, { signal }),
        item.id,
        revision
      ),
    enabled: accepted,
    initialData: item.purge ?? undefined,
    retry: false,
    gcTime: 0,
    refetchInterval: (q) =>
      q.state.error || q.state.data?.state === 'complete' ? false : 5000,
  })
  async function submit() {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError('')
    try {
      const result = validate(
        await fetchApi<PurgeReceipt>(path, {
          method: 'POST',
          body: JSON.stringify({ expected_revision: revision }),
        }),
        item.id,
        revision
      )
      client.setQueryData(queryKey, result)
      if (mounted.current) setAccepted(true)
      void client.invalidateQueries({ queryKey: ['record-trash', viewerId] })
    } catch (err) {
      if (mounted.current)
        setError(
          err instanceof ApiError &&
            [400, 401, 403, 404, 409].includes(err.statusCode)
            ? 'trash.conflict'
            : 'purge.uncertain'
        )
    } finally {
      inFlight.current = false
      if (mounted.current) setBusy(false)
    }
  }
  return (
    <div
      className={css({
        display: 'flex',
        flexDirection: 'column',
        gap: 'md',
      })}
    >
      {query.isError ? (
        <>
          <p role="alert">{t('trash.unavailable')}</p>
          <Button onPress={() => void query.refetch()}>
            {t('library.refresh')}
          </Button>
        </>
      ) : (
        <>
          <p>{item.title}</p>
          {!accepted ? (
            <>
              <p>{t('purge.hint')}</p>
              <Checkbox
                isSelected={acknowledged}
                isDisabled={busy}
                onChange={setAcknowledged}
              >
                {t('purge.acknowledge')}
              </Checkbox>
            </>
          ) : query.data ? (
            <>
              <p role="status">{t(`purge.${query.data.state}`)}</p>
              {query.data.state === 'pending' && (
                <p>
                  {t('purge.wait', {
                    time: new Date(query.data.not_before).toLocaleString(),
                  })}
                </p>
              )}
            </>
          ) : (
            <p>{t('loading')}</p>
          )}
          {error && <p role="alert">{t(error)}</p>}
          {(!accepted || query.data?.can_retry) && (
            <Button
              isDisabled={
                busy ||
                error === 'trash.conflict' ||
                (!accepted && !acknowledged)
              }
              onPress={() => void submit()}
            >
              {t(accepted ? 'purge.retry' : 'purge.confirm')}
            </Button>
          )}
          {busy && <p role="status">{t('loading')}</p>}
        </>
      )}
      <Button variant="tertiary" isDisabled={busy} onPress={onClose}>
        {t('purge.close')}
      </Button>
    </div>
  )
}
