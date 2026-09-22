import { useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Modal, ModalBody, ModalFooter, ModalHeader } from '@/components/Modal'
import { Button } from '@/primitives'
import { Select } from '@/primitives/Select'
import { css } from '@/styled-system/css'
import { fetchApi } from '@/api/fetchApi'
import { ApiError } from '@/api/ApiError'
import { DirectoryMultiPicker, MemberAvatar } from '@/features/contacts'
import { ShareToChatDialog } from '@/features/im/components/ShareToChatDialog'
import { buildMeetingRecordCardBody } from '@/features/im/components/meetingRecordCard'

export type MaterialScope = 'record' | 'minutes'
type Role = 'reader' | 'editor' | 'manager'
type Person = { id: string; name: string; avatar_url?: string | null }
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
/** candidates/ 分页与共享选人面板同一套游标契约。 */
type CandidatePage = {
  results: Person[]
  next_cursor: string | null
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

/**
 * 一行的所有形态:所有者、普通成员、以及「不可管理时只读」。
 *
 * 抽出来是因为它在成员名单里要出现一次,而每种形态的组合(角色下拉 /
 * 设为所有者 / 移除)本该只有一处定义 —— 否则「角色下拉用原生 select 还是
 * 基元」「移除按钮走哪种 danger」这类细节会各写一遍。
 */
function Card({
  label,
  avatarSrc,
  role,
  onRoleChange,
  onTransfer,
  onRemove,
}: {
  label: string
  avatarSrc?: string | null
  role?: Role | 'owner'
  onRoleChange?: (role: Role) => void
  onTransfer?: () => void
  onRemove?: () => void
}) {
  const { t } = useTranslation('meetings')
  return (
    <div className={collaboratorCard}>
      <MemberAvatar name={label} src={avatarSrc} size="2rem" />
      <span className={collaboratorName}>{label}</span>
      {role === 'owner' ? (
        <span className={ownerTag}>{t('collaboration.owner')}</span>
      ) : (
        <>
          {role &&
            (onRoleChange ? (
              // 改角色直接提交,不再问一次「确认修改?」:可逆、有回执,
              // 而且服务端会按 expected_revision 挡住过期写入。
              <select
                className={roleSelect}
                aria-label={label}
                value={role}
                onChange={(event) => onRoleChange(event.target.value as Role)}
              >
                {(['reader', 'editor', 'manager'] as Role[]).map((value) => (
                  <option key={value} value={value}>
                    {t(`collaboration.${value}`)}
                  </option>
                ))}
              </select>
            ) : (
              role && (
                <span className={ownerTag}>{t(`collaboration.${role}`)}</span>
              )
            ))}
          {onTransfer && (
            <Button size="sm" variant="tertiary" onPress={onTransfer}>
              {t('collaboration.transfer')}
            </Button>
          )}
          {onRemove && (
            <Button size="sm" variant="tertiary" onPress={onRemove}>
              {t('collaboration.remove')}
            </Button>
          )}
        </>
      )}
    </div>
  )
}

/**
 * 协作者管理 —— 邀请与成员管理在同一个弹窗里,两个视图。
 *
 * 选人这一步复用通讯录多选([DirectoryMultiPicker],与日历「添加参与者」、
 * 云文档「邀请成员」同一块面板),不再手写搜索框 + 复选框列表:那一版既没有
 * 头像、也不支持已选区,还各自实现了一遍分页。
 *
 * 与云文档邀请一致,整批邀请给同一个角色,邀请后需要单独调整的到成员名单里改。
 * 逐人配角色要多一次「下一步」,而真正会用到它的人极少。
 *
 * 撤销/移除仍是「先看清再确认」之外最危险的一步,所以 `confirm` 只保留给
 * 移除、设为所有者与链接范围 —— 角色调整直接生效。
 */
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
  const [step, setStep] = useState<'members' | 'invite'>('members')
  const [notify, setNotify] = useState(true)
  const [note, setNote] = useState('')
  const [selected, setSelected] = useState(new Map<string, string>())
  const [inviteRole, setInviteRole] = useState<Role>('reader')
  const [confirm, setConfirm] = useState<Change | null>(null)
  const [busy, setBusy] = useState(false)
  const flight = useRef(false)
  const [message, setMessage] = useState('')
  const query = useQuery({
    // `path` 完全由 viewerId/recordId/scope 派生(见上面的模板),不需要单独进 key。
    /* eslint-disable @tanstack/query/exhaustive-deps */
    queryKey: ['material-collaboration', viewerId, recordId, scope],
    /* eslint-enable @tanstack/query/exhaustive-deps */
    queryFn: ({ signal }) =>
      fetchApi<Access>(path, { signal, cache: 'no-store' }),
    retry: false,
    gcTime: 0,
    staleTime: 0,
    refetchInterval: 5000,
  })
  const data = query.isError ? undefined : query.data
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
      setSelected(new Map())
      setNote('')
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
  const rows = data?.results ?? []
  // 已经直接授权过的人不再出现在候选里(团队授权不算 —— 那些人没出现在名单上)。
  const excludeIds = new Set(rows.map((member) => member.id))
  const canTransfer = (member: Member) =>
    !!data?.is_owner && member.active && !member.id.includes(':')
  const selectedRows = [...selected.entries()]
  const linkOptions: Access['link_scope'][] = [
    'private',
    ...(data?.can_link_organization ? (['organization'] as const) : []),
  ]
  const close = () => {
    if (!busy) onClose()
  }
  // 记录来源与是否通知放在「邀请」那一步旁边,而不是成员名单上:它们只在
  // 邀请时有意义,让人在点下邀请前最后一刻看到。
  const inviteFooter = (
    <div
      className={css({
        display: 'flex',
        flexDirection: 'column',
        gap: 'sm',
        paddingX: 'lg',
        paddingY: 'md',
        flexShrink: 0,
        borderTop: '1px solid token(colors.border.subtle)',
      })}
    >
      <Select
        aria-label={t('collaboration.role')}
        label={
          <span className={css({ textStyle: 'labelMedium' })}>
            {t('collaboration.role')}
          </span>
        }
        selectedKey={inviteRole}
        isDisabled={busy}
        onSelectionChange={(key) => setInviteRole(key as Role)}
        items={(['reader', 'editor', 'manager'] as Role[]).map((value) => ({
          value,
          label: t(`collaboration.${value}`),
        }))}
      />
      <p className={css({ textStyle: 'bodySmall', color: 'text.secondary' })}>
        {t('collaboration.inviteHint')}
      </p>
      {data?.can_notify && (
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
      {(storageError || storageReadFailed.current) && (
        <p role="alert">{t('summarySharing.storageUnavailable')}</p>
      )}
      {message && <p role="status">{message}</p>}
    </div>
  )
  return (
    <Modal
      ariaLabel={t('collaboration.manage')}
      onClose={close}
      maxWidth="640px"
      maxHeight="86vh"
    >
      <ModalHeader
        closeLabel={t('collaboration.close')}
        title={t(
          step === 'members' ? 'collaboration.manage' : 'collaboration.invite'
        )}
        subtitle={`${t(`collaboration.${scope}`)} · ${title}`}
        onClose={close}
      />
      {query.isError ? (
        <ModalBody>
          <div className={stack}>
            <p role="alert">{t('collaboration.error')}</p>
            <Button onPress={() => void query.refetch()}>
              {t('collaboration.retry')}
            </Button>
          </div>
        </ModalBody>
      ) : !data ? (
        <ModalBody>
          <p role="status">{t('loading')}</p>
        </ModalBody>
      ) : pending ? (
        <ModalBody>
          <div className={stack}>
            <p>{t('collaboration.uncertain')}</p>
            <p>{t('collaboration.retryPending')}</p>
            <Button
              isDisabled={busy || !data.can_manage}
              onPress={() => void save()}
            >
              {t('collaboration.retry')}
            </Button>
          </div>
        </ModalBody>
      ) : confirm ? (
        <ModalBody>
          <div className={stack}>
            <p>{t(`collaboration.confirm_${confirm.operation}`)}</p>
            {confirm.members?.map((member) => (
              <p key={member.id}>
                {rows.find((entry) => entry.id === member.id)?.name}{' '}
                {confirm.operation === 'role' &&
                  t(`collaboration.${member.role}`)}
              </p>
            ))}
            <div className={row}>
              <Button
                isDisabled={busy || !data.can_manage}
                onPress={() => void save(confirm)}
              >
                {t('collaboration.confirm')}
              </Button>
              <Button variant="tertiary" onPress={() => setConfirm(null)}>
                {t('collaboration.back')}
              </Button>
            </div>
          </div>
        </ModalBody>
      ) : step === 'invite' ? (
        <>
          <ModalBody
            padding="none"
            className={css({
              display: 'flex',
              flexDirection: 'column',
              minHeight: 0,
            })}
          >
            <DirectoryMultiPicker
              selected={selected}
              onToggle={(id, label) => {
                if (busy) return
                setSelected((prev) => {
                  const next = new Map(prev)
                  if (next.has(id)) next.delete(id)
                  else next.set(id, label)
                  return next
                })
              }}
              excludeIds={excludeIds}
              testIdPrefix="material-invite-item-"
              searchTestId="material-invite-search"
              sourceLabel={t('collaboration.source')}
              sources={[
                { value: 'users', label: t('collaboration.users') },
                {
                  value: 'departments',
                  label: t('collaboration.departments'),
                },
                ...(scope === 'minutes'
                  ? [{ value: 'groups', label: t('collaboration.groups') }]
                  : []),
              ].map((source) => ({
                ...source,
                load: ({ query, cursor }: { query: string; cursor?: string }) =>
                  fetchApi<CandidatePage>(
                    `${path}candidates/?${new URLSearchParams({
                      kind: source.value,
                      q: query,
                      ...(cursor ? { cursor } : {}),
                    })}`,
                    { cache: 'no-store' }
                  ),
              }))}
              labels={{
                searchPlaceholder: t('collaboration.search'),
                selectedTitle: t('collaboration.selected', {
                  count: selected.size,
                }),
                loading: t('loading'),
                empty: t('collaboration.noCandidates'),
                loadMore: t('library.next'),
              }}
            />
          </ModalBody>
          {inviteFooter}
          <ModalFooter alignment="space-between">
            <Button
              variant="tertiary"
              isDisabled={busy}
              onPress={() => {
                setStep('members')
                setSelected(new Map())
                setNote('')
              }}
            >
              {t('collaboration.back')}
            </Button>
            <Button
              isDisabled={!selected.size || busy || !data.can_manage}
              loading={busy}
              onPress={() =>
                void save({
                  operation: 'invite',
                  // 备注只在服务端确认可通知时才发:否则 note 字段本身就是
                  // 「不允许出现」的载荷。
                  ...(data.can_notify ? { notify, note } : {}),
                  members: selectedRows.map(([id]) => ({
                    id,
                    role: inviteRole,
                  })),
                })
              }
            >
              {t('collaboration.invite')}
            </Button>
          </ModalFooter>
        </>
      ) : (
        <>
          <ModalBody>
            <div className={stack}>
              <div className={row}>
                <strong>
                  {t('collaboration.count', { count: data.count })}
                </strong>
                {data.can_manage && (
                  <Button
                    size="sm"
                    onPress={() => {
                      setStep('invite')
                      setMessage('')
                    }}
                  >
                    {t('collaboration.invite')}
                  </Button>
                )}
              </div>
              {rows.map((member) => (
                <Card
                  key={member.id}
                  label={member.name || member.id}
                  avatarSrc={member.avatar_url}
                  role={member.role}
                  onRoleChange={(role) =>
                    // 直接提交:不再让用户在「改了下拉」和「确认」之间多点一次。
                    void save({
                      operation: 'role',
                      members: [{ id: member.id, role }],
                    })
                  }
                  onTransfer={
                    canTransfer(member)
                      ? () =>
                          setConfirm({
                            expected_revision: data.revision,
                            operation: 'transfer',
                            members: [
                              { id: member.id, role: member.role as Role },
                            ],
                          })
                      : undefined
                  }
                  onRemove={
                    member.role === 'owner' || !data.can_manage
                      ? undefined
                      : () =>
                          setConfirm({
                            expected_revision: data.revision,
                            operation: 'remove',
                            members: [
                              { id: member.id, role: member.role as Role },
                            ],
                          })
                  }
                />
              ))}
              {!data.can_manage && (
                <p
                  className={css({
                    textStyle: 'bodySmall',
                    color: 'text.secondary',
                  })}
                >
                  {t('collaboration.viewOnly')}
                </p>
              )}
              {!!data.pending_notifications && (
                <Button
                  variant="tertiary"
                  onPress={() => {
                    void fetchApi(`${path}notifications/retry/`, {
                      method: 'POST',
                    }).then(
                      () => setMessage(t('collaboration.notificationPending')),
                      () => setMessage(t('collaboration.error'))
                    )
                  }}
                >
                  {t('collaboration.retryNotifications')}
                </Button>
              )}
              <hr />
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
                      link_scope: event.target.value as Access['link_scope'],
                    })
                  }
                >
                  {linkOptions.map((value) => (
                    <option key={value} value={value}>
                      {t(`collaboration.${value}`)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {message && <p role="status">{message}</p>}
          </ModalBody>
          <ModalFooter>
            <Button variant="tertiary" isDisabled={busy} onPress={close}>
              {t('collaboration.close')}
            </Button>
          </ModalFooter>
        </>
      )}
    </Modal>
  )
}

const collaboratorCard = css({
  display: 'flex',
  alignItems: 'center',
  gap: 'sm',
  minWidth: 0,
  minHeight: '3rem',
  padding: 'sm',
  backgroundColor: 'surface.default',
  border: '1px solid token(colors.border.subtle)',
  borderRadius: 'control',
})

const collaboratorName = css({
  flex: 1,
  minWidth: 0,
  textStyle: 'bodyMedium',
  fontWeight: 'medium',
  color: 'text.primary',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
})

const ownerTag = css({
  flexShrink: 0,
  paddingX: 'sm',
  paddingY: '0.125rem',
  borderRadius: 'pill',
  backgroundColor: 'action.selected.bg',
  color: 'action.selected.text',
  textStyle: 'labelSmall',
})

const roleSelect = css({
  flexShrink: 0,
  padding: 'sm',
  border: '1px solid token(colors.border.subtle)',
  borderRadius: 'md',
  background: 'transparent',
  color: 'inherit',
})
