import { useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Modal, ModalBody, ModalFooter, ModalHeader } from '@/components/Modal'
import { Button } from '@/primitives'
import { css } from '@/styled-system/css'
import { fetchApi } from '@/api/fetchApi'
import { ApiError } from '@/api/ApiError'
import { ShareToChatDialog } from '@/features/im/components/ShareToChatDialog'
import { buildMeetingRecordCardBody } from '@/features/im/components/meetingRecordCard'

export type MaterialScope = 'record' | 'minutes'
type Role = 'reader' | 'editor' | 'manager'
type Person = { id: string; name: string }
type Member = Person & { role: Role | 'owner'; active: boolean }
type Access = {
  scope: MaterialScope
  record_id: string
  revision: number
  can_manage: boolean
  is_owner: boolean
  link_scope: 'private' | 'organization'
  can_link_organization: boolean
  results: Member[]
  count: number
  can_notify: boolean
  pending_notifications: number
}
type Change = {
  operation: 'invite' | 'role' | 'remove' | 'transfer' | 'link'
  members?: { id: string; role: Role }[]
  link_scope?: 'private' | 'organization'
  expected_revision: number
  notify?: boolean
  note?: string
}
const stack = css({
  display: 'flex',
  flexDirection: 'column',
  gap: 'md',
  minWidth: 0,
})
const row = css({
  display: 'flex',
  alignItems: 'center',
  gap: 'md',
  flexWrap: 'wrap',
})
const field = css({
  padding: 'sm',
  border: '1px solid token(colors.border.subtle)',
  borderRadius: 'md',
  background: 'transparent',
  color: 'inherit',
  maxWidth: '100%',
})

export const materialLink = (recordId: string, scope: MaterialScope) =>
  `/meeting/records/${encodeURIComponent(recordId)}?tab=${scope === 'minutes' ? 'summary' : 'overview'}`

export function MaterialActions({
  recordId,
  viewerId,
  scope,
  title,
  originAt,
}: {
  recordId: string
  viewerId: string
  scope: MaterialScope
  title: string
  originAt?: string
}) {
  const { t } = useTranslation('meetings')
  const [panel, setPanel] = useState<'share' | 'members' | 'chat' | null>(null)
  const [message, setMessage] = useState('')
  const heading = t(`collaboration.${scope}`)
  return (
    <div className={row}>
      <Button
        size="sm"
        variant="tertiary"
        onPress={() => {
          setMessage('')
          setPanel('share')
        }}
      >
        {t('collaboration.share')}
      </Button>
      <Button size="sm" variant="tertiary" onPress={() => setPanel('members')}>
        {t('collaboration.manage')}
      </Button>
      {panel === 'share' && (
        <Modal
          ariaLabel={t('collaboration.share')}
          onClose={() => setPanel(null)}
          maxWidth="440px"
        >
          <ModalHeader
            closeLabel={t('collaboration.close')}
            title={t('collaboration.share')}
            subtitle={`${heading} · ${title}`}
            onClose={() => setPanel(null)}
          />
          <ModalBody>
            <div className={stack}>
              <Button onPress={() => setPanel('chat')}>
                {t('collaboration.send')}
              </Button>
              <Button
                variant="tertiary"
                onPress={() => {
                  void navigator.clipboard
                    .writeText(
                      `${location.origin}${materialLink(recordId, scope)}`
                    )
                    .then(
                      () => setMessage(t('collaboration.copied')),
                      () => setMessage(t('collaboration.error'))
                    )
                }}
              >
                {t('collaboration.copy')}
              </Button>
              {message && <p role="status">{message}</p>}
            </div>
          </ModalBody>
        </Modal>
      )}
      {panel === 'chat' && (
        <ShareToChatDialog
          title={t('collaboration.send')}
          body={buildMeetingRecordCardBody({
            recordId,
            title,
            originAt,
            scope,
          })}
          contentType="meeting-record-card"
          previewText={`${heading} · ${title}`}
          errorMessage={t('collaboration.error')}
          onClose={() => setPanel(null)}
        />
      )}
      {panel === 'members' && (
        <MaterialMembers
          key={`${viewerId}:${recordId}:${scope}`}
          recordId={recordId}
          viewerId={viewerId}
          scope={scope}
          title={title}
          onClose={() => setPanel(null)}
        />
      )}
    </div>
  )
}

function MaterialMembers({
  recordId,
  viewerId,
  scope,
  title,
  onClose,
}: {
  recordId: string
  viewerId: string
  scope: MaterialScope
  title: string
  onClose: () => void
}) {
  const { t } = useTranslation('meetings')
  const client = useQueryClient()
  const path = `meeting-records/${recordId}/collaboration/${scope}/`
  const storageKey = `meeting-collaboration:${viewerId}:${recordId}:${scope}`
  const [storageError, setStorageError] = useState(false)
  const storageReadFailed = useRef(false)
  const [pending, setPending] = useState<{ key: string; body: Change } | null>(
    () => {
      try {
        const value = JSON.parse(sessionStorage.getItem(storageKey) || 'null')
        if (
          value !== null &&
          (!value ||
            typeof value.key !== 'string' ||
            !/^[0-9a-f-]{36}$/i.test(value.key) ||
            !value.body ||
            !Number.isInteger(value.body.expected_revision) ||
            !['invite', 'role', 'remove', 'transfer', 'link'].includes(
              value.body.operation
            ))
        )
          throw new Error('Invalid saved operation')
        return value
      } catch {
        storageReadFailed.current = true
        return null
      }
    }
  )
  const [step, setStep] = useState<'members' | 'select' | 'invite'>('members')
  const [search, setSearch] = useState('')
  const [kind, setKind] = useState('users')
  const [notify, setNotify] = useState(true)
  const [note, setNote] = useState('')
  const [offset, setOffset] = useState(0)
  const [selected, setSelected] = useState<
    Record<string, Person & { role: Role }>
  >({})
  const [confirm, setConfirm] = useState<Change | null>(null)
  const [busy, setBusy] = useState(false)
  const flight = useRef(false)
  const [message, setMessage] = useState('')
  const query = useQuery({
    queryKey: ['material-collaboration', viewerId, recordId, scope],
    queryFn: ({ signal }) =>
      fetchApi<Access>(path, { signal, cache: 'no-store' }),
    retry: false,
    gcTime: 0,
    staleTime: 0,
    refetchInterval: 5000,
  })
  const data = query.isError ? undefined : query.data
  const candidates = useQuery({
    queryKey: [
      'material-candidates',
      viewerId,
      recordId,
      scope,
      kind,
      search,
      offset,
    ],
    enabled: step === 'select' && !!data?.can_manage,
    queryFn: ({ signal }) =>
      fetchApi<{ results: Person[]; next_offset: number | null }>(
        `${path}candidates/?kind=${kind}&q=${encodeURIComponent(search)}&offset=${offset}`,
        { signal, cache: 'no-store' }
      ),
    retry: false,
    gcTime: 0,
  })
  const save = async (
    change?: Omit<Change, 'expected_revision'> & { expected_revision?: number }
  ) => {
    if (
      !data?.can_manage ||
      flight.current ||
      storageError ||
      storageReadFailed.current
    )
      return
    const intent =
      pending ??
      (change && {
        key: crypto.randomUUID(),
        body: {
          ...change,
          expected_revision: change.expected_revision ?? data.revision,
        },
      })
    if (!intent) return
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(intent))
    } catch {
      setStorageError(true)
      return
    }
    flight.current = true
    setBusy(true)
    setPending(intent)
    setMessage('')
    try {
      await fetchApi(path, {
        method: 'POST',
        headers: { 'Idempotency-Key': intent.key },
        body: JSON.stringify(intent.body),
      })
      sessionStorage.removeItem(storageKey)
      setPending(null)
      setConfirm(null)
      setStep('members')
      setSelected({})
      setMessage(t('collaboration.saved'))
    } catch (error) {
      if (
        error instanceof ApiError &&
        [400, 403, 404, 409].includes(error.statusCode)
      ) {
        sessionStorage.removeItem(storageKey)
        setPending(null)
        setConfirm(null)
        setMessage(t('collaboration.changed'))
      } else setMessage(t('collaboration.uncertain'))
    } finally {
      flight.current = false
      setBusy(false)
      await client.invalidateQueries({
        queryKey: ['meeting-records', viewerId],
      })
      await query.refetch()
    }
  }
  const roleSelect = (
    value: Role,
    label: string,
    onChange: (role: Role) => void
  ) => (
    <select
      className={field}
      aria-label={label}
      value={value}
      disabled={busy || !!pending}
      onChange={(event) => onChange(event.target.value as Role)}
    >
      {(['reader', 'editor', 'manager'] as Role[]).map((role) => (
        <option key={role} value={role}>
          {t(`collaboration.${role}`)}
        </option>
      ))}
    </select>
  )
  const selectedRows = Object.values(selected)
  const close = () => {
    if (!busy) onClose()
  }
  return (
    <Modal
      ariaLabel={t('collaboration.manage')}
      onClose={close}
      maxWidth="620px"
      maxHeight="88vh"
    >
      <ModalHeader
        closeLabel={t('collaboration.close')}
        title={t(
          step === 'members' ? 'collaboration.manage' : 'collaboration.invite'
        )}
        subtitle={`${t(`collaboration.${scope}`)} · ${title}`}
        onClose={close}
      />
      <ModalBody>
        <div className={stack}>
          {query.isError ? (
            <>
              <p role="alert">{t('collaboration.error')}</p>
              <Button onPress={() => void query.refetch()}>
                {t('collaboration.retry')}
              </Button>
            </>
          ) : !data ? (
            <p role="status">{t('loading')}</p>
          ) : (
            <>
              {pending ? (
                <>
                  <p>{t('collaboration.uncertain')}</p>
                  <Button
                    isDisabled={busy || !data.can_manage}
                    onPress={() => void save()}
                  >
                    {t('collaboration.retry')}
                  </Button>
                </>
              ) : confirm ? (
                <>
                  <p>{t(`collaboration.confirm_${confirm.operation}`)}</p>
                  {confirm.members?.map((member) => (
                    <p key={member.id}>
                      {data.results.find((row) => row.id === member.id)?.name}{' '}
                      {confirm.operation === 'role' &&
                        t(`collaboration.${member.role}`)}
                    </p>
                  ))}
                  <Button
                    isDisabled={busy || !data.can_manage}
                    onPress={() => void save(confirm)}
                  >
                    {t('collaboration.confirm')}
                  </Button>
                  <Button variant="tertiary" onPress={() => setConfirm(null)}>
                    {t('collaboration.back')}
                  </Button>
                </>
              ) : step === 'members' ? (
                <>
                  <div className={row}>
                    <strong>
                      {t('collaboration.count', { count: data.count })}
                    </strong>
                    {data.can_manage && (
                      <Button
                        size="sm"
                        onPress={() => {
                          setStep('select')
                          setMessage('')
                        }}
                      >
                        {t('collaboration.invite')}
                      </Button>
                    )}
                  </div>
                  {data.results.map((member) => (
                    <div className={row} key={member.id}>
                      <span
                        className={css({ flex: '1', overflowWrap: 'anywhere' })}
                      >
                        {member.name || member.id}
                      </span>
                      {member.role === 'owner' || !data.can_manage ? (
                        <span>{t(`collaboration.${member.role}`)}</span>
                      ) : (
                        <>
                          {roleSelect(member.role, member.name, (role) =>
                            setConfirm({
                              expected_revision: data.revision,
                              operation: 'role',
                              members: [{ id: member.id, role }],
                            })
                          )}
                          {data.is_owner &&
                            member.active &&
                            !member.id.includes(':') && (
                              <Button
                                size="sm"
                                variant="tertiary"
                                onPress={() =>
                                  setConfirm({
                                    expected_revision: data.revision,
                                    operation: 'transfer',
                                    members: [
                                      {
                                        id: member.id,
                                        role: member.role as Role,
                                      },
                                    ],
                                  })
                                }
                              >
                                {t('collaboration.transfer')}
                              </Button>
                            )}
                          <Button
                            size="sm"
                            variant="tertiary"
                            onPress={() =>
                              setConfirm({
                                expected_revision: data.revision,
                                operation: 'remove',
                                members: [
                                  { id: member.id, role: member.role as Role },
                                ],
                              })
                            }
                          >
                            {t('collaboration.remove')}
                          </Button>
                        </>
                      )}
                    </div>
                  ))}
                  <hr />
                  {!!data.pending_notifications && (
                    <Button
                      variant="tertiary"
                      onPress={() => {
                        void fetchApi(`${path}notifications/retry/`, {
                          method: 'POST',
                        }).then(
                          () =>
                            setMessage(t('collaboration.notificationPending')),
                          () => setMessage(t('collaboration.error'))
                        )
                      }}
                    >
                      {t('collaboration.retryNotifications')}
                    </Button>
                  )}
                  <strong>{t('collaboration.permissions')}</strong>
                  <label className={stack}>
                    {t('collaboration.link')}
                    <select
                      className={field}
                      value={data.link_scope}
                      disabled={!data.can_manage}
                      onChange={(event) =>
                        setConfirm({
                          expected_revision: data.revision,
                          operation: 'link',
                          link_scope: event.target
                            .value as Access['link_scope'],
                        })
                      }
                    >
                      <option value="private">
                        {t('collaboration.private')}
                      </option>
                      {data.can_link_organization && (
                        <option value="organization">
                          {t('collaboration.organization')}
                        </option>
                      )}
                    </select>
                  </label>
                </>
              ) : step === 'select' ? (
                <>
                  <select
                    className={field}
                    aria-label={t('collaboration.source')}
                    value={kind}
                    onChange={(event) => {
                      setKind(event.target.value)
                      setOffset(0)
                    }}
                  >
                    {[
                      'users',
                      'departments',
                      ...(scope === 'minutes' ? ['groups'] : []),
                    ].map((value) => (
                      <option key={value} value={value}>
                        {t(`collaboration.${value}`)}
                      </option>
                    ))}
                  </select>
                  <input
                    className={field}
                    aria-label={t('collaboration.search')}
                    placeholder={t('collaboration.search')}
                    value={search}
                    maxLength={80}
                    onChange={(event) => {
                      setSearch(event.target.value)
                      setOffset(0)
                    }}
                  />
                  <p>
                    {t('collaboration.selected', {
                      count: selectedRows.length,
                    })}
                  </p>
                  {candidates.isError ? (
                    <p role="alert">{t('collaboration.error')}</p>
                  ) : candidates.isPending ? (
                    <p>{t('loading')}</p>
                  ) : (
                    candidates.data?.results.map((person) => (
                      <label key={person.id} className={row}>
                        <input
                          type="checkbox"
                          checked={!!selected[person.id]}
                          disabled={
                            data.results.some(
                              (member) => member.id === person.id
                            ) ||
                            (!selected[person.id] && selectedRows.length >= 50)
                          }
                          onChange={(event) =>
                            setSelected((previous) => {
                              const next = { ...previous }
                              if (event.target.checked)
                                next[person.id] = { ...person, role: 'reader' }
                              else delete next[person.id]
                              return next
                            })
                          }
                        />
                        {person.name || person.id}
                      </label>
                    ))
                  )}
                  <div className={row}>
                    {offset > 0 && (
                      <Button
                        variant="tertiary"
                        onPress={() => setOffset(Math.max(0, offset - 50))}
                      >
                        {t('library.previous')}
                      </Button>
                    )}
                    {candidates.data?.next_offset != null && (
                      <Button
                        variant="tertiary"
                        onPress={() => setOffset(candidates.data!.next_offset!)}
                      >
                        {t('library.next')}
                      </Button>
                    )}
                  </div>
                  <Button
                    isDisabled={!selectedRows.length}
                    onPress={() => setStep('invite')}
                  >
                    {t('collaboration.next')}
                  </Button>
                  <Button variant="tertiary" onPress={() => setStep('members')}>
                    {t('collaboration.back')}
                  </Button>
                </>
              ) : (
                <>
                  {selectedRows.map((person) => (
                    <div key={person.id} className={row}>
                      <span>{person.name || person.id}</span>
                      {roleSelect(person.role, person.name, (role) =>
                        setSelected((previous) => ({
                          ...previous,
                          [person.id]: { ...person, role },
                        }))
                      )}
                      <Button
                        size="sm"
                        variant="tertiary"
                        onPress={() =>
                          setSelected((previous) => {
                            const next = { ...previous }
                            delete next[person.id]
                            return next
                          })
                        }
                      >
                        {t('collaboration.remove')}
                      </Button>
                    </div>
                  ))}
                  {data.can_notify && (
                    <>
                      <textarea
                        className={field}
                        maxLength={1000}
                        value={note}
                        aria-label={t('collaboration.note')}
                        placeholder={t('collaboration.note')}
                        onChange={(event) => setNote(event.target.value)}
                      />
                      <label className={row}>
                        <input
                          type="checkbox"
                          checked={notify}
                          onChange={(event) => setNotify(event.target.checked)}
                        />
                        {t('collaboration.notify')}
                      </label>
                    </>
                  )}
                  <Button
                    isDisabled={
                      !selectedRows.length || busy || !data.can_manage
                    }
                    onPress={() =>
                      void save({
                        operation: 'invite',
                        notify: data.can_notify && notify,
                        note,
                        members: selectedRows.map(({ id, role }) => ({
                          id,
                          role,
                        })),
                      })
                    }
                  >
                    {t('collaboration.invite')}
                  </Button>
                  <Button variant="tertiary" onPress={() => setStep('select')}>
                    {t('collaboration.back')}
                  </Button>
                </>
              )}
            </>
          )}
          {(storageError || storageReadFailed.current) && (
            <p role="alert">{t('summarySharing.storageUnavailable')}</p>
          )}
          {message && <p role="status">{message}</p>}
        </div>
      </ModalBody>
      <ModalFooter>
        <Button variant="tertiary" isDisabled={busy} onPress={close}>
          {t('collaboration.close')}
        </Button>
      </ModalFooter>
    </Modal>
  )
}
