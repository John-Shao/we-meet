import { Menu as AriaMenu, MenuItem } from 'react-aria-components'
import { Menu } from '@/primitives/Menu'
import { menuRecipe } from '@/primitives/menuRecipe'
import { IconButton } from '@/primitives/IconButton'
import { RiMore2Line } from '@remixicon/react'
import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { RiDeleteBinLine } from '@remixicon/react'
import { useLocation } from 'wouter'
import { ApiError } from '@/api/ApiError'
import { fetchApi } from '@/api/fetchApi'
import { Button, Dialog } from '@/primitives'
import { css } from '@/styled-system/css'
import { RecordPurge, type PurgeReceipt } from './RecordPurge'
import type {
  ApiMeetingRecord,
  MeetingRecordPage,
} from '../api/ApiMeetingRecord'
import { formatDateTime } from '../recordDateTime'

type TrashRecord = {
  id: string
  title: string
  deleted_at: string | null
  lifecycle_revision: number
  purge?: PurgeReceipt | null
}
const stack = css({ display: 'flex', flexDirection: 'column', gap: 'md' })

function LifecycleConfirmation({
  viewerId,
  item,
  target,
  onDone,
  onCancel,
}: {
  viewerId: string
  item: TrashRecord
  target: 'active' | 'trashed'
  onDone: () => void
  onCancel: () => void
}) {
  const { t } = useTranslation('meetings')
  const client = useQueryClient()
  const inFlight = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function submit() {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError('')
    try {
      const result = await fetchApi<TrashRecord>(
        `meeting-records/${encodeURIComponent(item.id)}/lifecycle/`,
        {
          method: 'PATCH',
          body: JSON.stringify({
            target,
            expected_revision: item.lifecycle_revision,
          }),
        }
      )
      if (
        result.id !== item.id ||
        Boolean(result.deleted_at) !== (target === 'trashed')
      )
        throw new Error('Unexpected lifecycle result')
      await Promise.allSettled([
        client.invalidateQueries({ queryKey: ['meeting-records', viewerId] }),
        client.invalidateQueries({ queryKey: ['record-trash', viewerId] }),
      ])
      if (mounted.current) onDone()
    } catch (err) {
      if (mounted.current)
        setError(
          err instanceof ApiError &&
            [400, 401, 403, 404, 409].includes(err.statusCode)
            ? 'trash.conflict'
            : 'trash.uncertain'
        )
    } finally {
      inFlight.current = false
      if (mounted.current) setBusy(false)
    }
  }
  return (
    <div className={stack}>
      <p>{item.title}</p>
      <p>
        {t(target === 'trashed' ? 'trash.removeHint' : 'trash.restoreHint')}
      </p>
      {error && <p role="alert">{t(error)}</p>}
      {busy && <p role="status">{t('loading')}</p>}
      <Button
        isDisabled={busy || error === 'trash.conflict'}
        onPress={() => void submit()}
      >
        {t(
          target === 'trashed' ? 'trash.confirmRemove' : 'trash.confirmRestore'
        )}
      </Button>
      <Button variant="tertiary" isDisabled={busy} onPress={onCancel}>
        {t('trash.cancel')}
      </Button>
    </div>
  )
}

export function RecordTrashControl({
  viewerId,
  record,
  menu = false,
}: {
  viewerId: string
  record: ApiMeetingRecord
  menu?: boolean
}) {
  const { t } = useTranslation('meetings')
  const [, navigate] = useLocation()
  const [selected, setSelected] = useState<TrashRecord>()
  if (!record.capabilities.trash || record.lifecycle_revision === undefined)
    return null
  const select = () =>
    setSelected({
      id: record.id,
      title: record.title,
      deleted_at: null,
      lifecycle_revision: record.lifecycle_revision!,
    })
  const classes = menuRecipe({ variant: 'light' })
  return (
    <>
      {menu ? (
        <Menu placement="bottom">
          <IconButton label={t('video.more')} size="icon32">
            <RiMore2Line size={20} aria-hidden />
          </IconButton>
          <AriaMenu className={classes.root} aria-label={t('video.more')}>
            <MenuItem
              className={classes.item}
              textValue={t('trash.remove')}
              onAction={select}
            >
              <span className={css({ color: 'status.danger' })}>
                {t('trash.remove')}
              </span>
            </MenuItem>
          </AriaMenu>
        </Menu>
      ) : (
        <Button
          size="sm"
          variant="quaternaryDanger"
          className={css({ color: 'status.danger' })}
          icon={<RiDeleteBinLine size={16} aria-hidden />}
          onPress={select}
        >
          {t('trash.remove')}
        </Button>
      )}
      <Dialog
        title={t('trash.remove')}
        isOpen={!!selected}
        onOpenChange={(open) => {
          if (!open) setSelected(undefined)
        }}
      >
        {selected && (
          <LifecycleConfirmation
            key={`${viewerId}:${selected.id}`}
            viewerId={viewerId}
            item={selected}
            target="trashed"
            onCancel={() => setSelected(undefined)}
            onDone={() => navigate('/meeting/notes')}
          />
        )}
      </Dialog>
    </>
  )
}

export function RecordTrashLibrary({ viewerId }: { viewerId: string }) {
  const { t } = useTranslation('meetings')
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button variant="tertiary" onPress={() => setOpen(true)}>
        {t('trash.title')}
      </Button>
      <Dialog title={t('trash.title')} isOpen={open} onOpenChange={setOpen}>
        {open && <TrashList key={viewerId} viewerId={viewerId} />}
      </Dialog>
    </>
  )
}

function TrashList({ viewerId }: { viewerId: string }) {
  const { t } = useTranslation('meetings')
  const [cursors, setCursors] = useState<(string | null)[]>([null])
  const [selected, setSelected] = useState<TrashRecord>()
  const [purging, setPurging] = useState<TrashRecord>()
  const cursor = cursors[cursors.length - 1]
  const query = useQuery({
    queryKey: ['record-trash', viewerId, cursor],
    queryFn: ({ signal }) =>
      fetchApi<MeetingRecordPage<TrashRecord> & { purge_available?: boolean }>(
        `meeting-records/trash/${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
        { signal }
      ),
    retry: false,
    gcTime: 0,
    staleTime: 0,
    refetchInterval: (q) => (q.state.error ? false : 15000),
  })
  if (query.isError)
    return (
      <div className={stack}>
        <p role="alert">{t('trash.unavailable')}</p>
        <Button
          onPress={() => {
            setSelected(undefined)
            void query.refetch()
          }}
        >
          {t('library.refresh')}
        </Button>
      </div>
    )
  if (selected)
    return (
      <LifecycleConfirmation
        key={selected.id}
        viewerId={viewerId}
        item={selected}
        target="active"
        onCancel={() => {
          setSelected(undefined)
          void query.refetch()
        }}
        onDone={() => {
          setSelected(undefined)
          setCursors([null])
          void query.refetch()
        }}
      />
    )
  if (purging)
    return (
      <RecordPurge
        key={`${viewerId}:${purging.id}`}
        viewerId={viewerId}
        item={purging}
        onClose={() => {
          setPurging(undefined)
          setCursors([null])
          void query.refetch()
        }}
      />
    )
  return (
    <div className={stack}>
      <p>
        {t(
          query.data?.purge_available
            ? 'purge.retentionHint'
            : 'trash.retentionHint'
        )}
      </p>
      {!query.data ? (
        <p>{t('loading')}</p>
      ) : !query.data.results.length ? (
        <p>{t('trash.empty')}</p>
      ) : (
        <div className={css({ maxHeight: '60vh', overflowY: 'auto' })}>
          {query.data.results.map((item) => (
            <article key={item.id} className={stack}>
              <p>
                {item.title} ·{' '}
                {item.deleted_at && formatDateTime(item.deleted_at)}
              </p>
              {!item.purge && (
                <Button variant="tertiary" onPress={() => setSelected(item)}>
                  {t('trash.restore')}
                </Button>
              )}
              {(item.purge || query.data?.purge_available) && (
                <Button variant="tertiary" onPress={() => setPurging(item)}>
                  {t(item.purge ? 'purge.status' : 'purge.remove')}
                </Button>
              )}
              {item.purge && <p>{t(`purge.${item.purge.state}`)}</p>}
            </article>
          ))}
        </div>
      )}
      {cursors.length > 1 && (
        <Button onPress={() => setCursors((values) => values.slice(0, -1))}>
          {t('library.previous')}
        </Button>
      )}
      {query.data?.next_cursor && (
        <Button
          onPress={() =>
            setCursors((values) => [...values, query.data!.next_cursor!])
          }
        >
          {t('library.next')}
        </Button>
      )}
    </div>
  )
}
