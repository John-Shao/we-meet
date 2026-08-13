import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { QRCodeSVG } from 'qrcode.react'

import { apiErrorMessage } from '@/api/apiErrorMessage'
import { Modal, ModalCloseButton } from '@/components/Modal'
import { DirectoryMultiPicker } from '@/features/contacts/components/DirectoryMultiPicker'
import { ShareToChatDialog } from '@/features/im/components/ShareToChatDialog'
import { css } from '@/styled-system/css'

import {
  addCalendarMember,
  authorizeExternalCalendar,
  createCalendar,
  createCalendarExport,
  deleteCalendar,
  disconnectExternalCalendarAccount,
  discoverCalendars,
  fetchCalendarMembers,
  fetchCalendarShareLink,
  fetchExternalCalendarAccounts,
  fetchProviderCalendars,
  removeCalendarMember,
  resetCalendarShareLink,
  selectProviderCalendars,
  setCalendarSubscription,
  syncExternalCalendarAccount,
  updateCalendar,
  updateCalendarMember,
  type CalendarRole,
  type ExternalCalendarAccount,
  type UnifiedCalendar,
} from '../api/calendars'

const roleLabels: Record<Exclude<CalendarRole, 'none'>, string> = {
  free_busy: '仅忙闲',
  details: '订阅者',
  writer: '编辑者',
  admin: '管理员',
}

const qrSvgBlob = () => {
  const svg = document.getElementById('calendar-share-qr')
  if (!(svg instanceof SVGElement)) throw new Error('二维码尚未生成')
  return new Blob([new XMLSerializer().serializeToString(svg)], {
    type: 'image/svg+xml;charset=utf-8',
  })
}

const downloadQrImage = (name: string) => {
  const url = URL.createObjectURL(qrSvgBlob())
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${name}-calendar-qr.svg`
  anchor.click()
  URL.revokeObjectURL(url)
}

const copyQrImage = async () => {
  const sourceUrl = URL.createObjectURL(qrSvgBlob())
  try {
    const image = new Image()
    image.src = sourceUrl
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = 440
    canvas.height = 440
    const context = canvas.getContext('2d')
    if (!context) throw new Error('浏览器不支持复制二维码')
    context.fillStyle = '#fff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    const png = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (value) =>
          value ? resolve(value) : reject(new Error('二维码生成失败')),
        'image/png'
      )
    )
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
  } finally {
    URL.revokeObjectURL(sourceUrl)
  }
}

const DialogFrame = ({
  title,
  onClose,
  children,
}: {
  title: string
  onClose: () => void
  children: React.ReactNode
}) => (
  <Modal onClose={onClose} ariaLabel={title} maxWidth="780px" maxHeight="88vh">
    <header className={headerCls}>
      <h2 className={titleCls}>{title}</h2>
      <ModalCloseButton onClose={onClose} label="关闭" />
    </header>
    <div className={bodyCls}>{children}</div>
  </Modal>
)

export const AddCalendarDialog = ({
  onClose,
  onChanged,
  initialMode = 'subscribe',
  externalEnabled = true,
}: {
  onClose: () => void
  onChanged: () => void
  initialMode?: 'subscribe' | 'create' | 'external'
  externalEnabled?: boolean
}) => {
  const qc = useQueryClient()
  const [mode, setMode] = useState<'subscribe' | 'create' | 'external'>(
    initialMode
  )
  const [discoverType, setDiscoverType] = useState<
    'contact' | 'room' | 'public'
  >('contact')
  const [query, setQuery] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [color, setColor] = useState('#3370ff')
  const [defaultAccess, setDefaultAccess] = useState<
    'none' | 'free_busy' | 'details'
  >('details')
  const [memberRole, setMemberRole] =
    useState<Exclude<CalendarRole, 'none'>>('details')
  const [members, setMembers] = useState<Map<string, string>>(new Map())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const { data: discoveries = [], isFetching } = useQuery({
    queryKey: ['calendar', 'discover', discoverType, query],
    queryFn: () => discoverCalendars(discoverType, query),
    enabled: mode === 'subscribe',
  })

  const changed = async () => {
    await qc.invalidateQueries({ queryKey: ['calendar', 'unified'] })
    onChanged()
  }

  const subscribe = async (calendar: UnifiedCalendar) => {
    setBusy(true)
    setError('')
    try {
      await setCalendarSubscription(calendar.id, { enabled: true })
      await changed()
    } catch (reason) {
      setError(apiErrorMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  const create = async () => {
    if (!name.trim()) return
    setBusy(true)
    setError('')
    try {
      await createCalendar({
        name: name.trim(),
        description,
        color,
        organization_default_access: defaultAccess,
        members: [...members.keys()].map((user_id) => ({
          user_id,
          role: memberRole,
        })),
      })
      await changed()
      onClose()
    } catch (reason) {
      setError(apiErrorMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <DialogFrame title="添加日历" onClose={onClose}>
      <div className={tabsCls}>
        {(
          [
            ['subscribe', '订阅日历'],
            ['create', '新建日历'],
            ...(externalEnabled
              ? ([['external', '添加第三方日历']] as const)
              : []),
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={mode === value ? activeTabCls : tabCls}
            onClick={() => setMode(value)}
          >
            {label}
          </button>
        ))}
      </div>
      {mode === 'subscribe' && (
        <div className={stackCls}>
          <input
            className={inputCls}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索联系人、会议室或公共日历"
          />
          <div className={tabsCls}>
            {(
              [
                ['contact', '联系人'],
                ['room', '会议室'],
                ['public', '公共日历'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={discoverType === value ? activeTabCls : tabCls}
                onClick={() => setDiscoverType(value)}
              >
                {label}
              </button>
            ))}
          </div>
          {isFetching ? (
            <p className={mutedCls}>正在搜索…</p>
          ) : discoveries.length === 0 ? (
            <p className={mutedCls}>没有可订阅的日历</p>
          ) : (
            discoveries.map((calendar) => (
              <div key={calendar.id} className={rowCls}>
                <span
                  className={dotCls}
                  style={{ background: calendar.color }}
                />
                <span className={growCls}>
                  <strong>{calendar.display_name}</strong>
                  <small className={mutedCls}>{calendar.description}</small>
                </span>
                <button
                  type="button"
                  className={primaryBtnCls}
                  disabled={busy || calendar.subscribed}
                  onClick={() => void subscribe(calendar)}
                >
                  {calendar.subscribed ? '已订阅' : '订阅'}
                </button>
              </div>
            ))
          )}
        </div>
      )}
      {mode === 'create' && (
        <div className={stackCls}>
          <label className={labelCls}>
            日历名称
            <input
              className={inputCls}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className={labelCls}>
            描述
            <textarea
              className={inputCls}
              value={description}
              maxLength={400}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          <label className={labelCls}>
            颜色
            <input
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
            />
          </label>
          <label className={labelCls}>
            组织内默认权限
            <select
              className={inputCls}
              value={defaultAccess}
              onChange={(e) =>
                setDefaultAccess(e.target.value as typeof defaultAccess)
              }
            >
              <option value="none">私密</option>
              <option value="free_busy">游客（仅忙闲）</option>
              <option value="details">订阅者（查看详情）</option>
            </select>
          </label>
          <label className={labelCls}>
            新增共享人的角色
            <RoleSelect value={memberRole} onChange={setMemberRole} />
          </label>
          <DirectoryMultiPicker
            selected={members}
            onToggle={(id, label) =>
              setMembers((current) => {
                const next = new Map(current)
                if (next.has(id)) next.delete(id)
                else next.set(id, label)
                return next
              })
            }
            includeExternal
            labels={{
              searchPlaceholder: '搜索共享人',
              selectedTitle: `已选 ${members.size} 人`,
              loading: '加载中',
              empty: '没有结果',
              loadMore: '加载更多',
            }}
          />
          <button
            type="button"
            className={primaryBtnCls}
            disabled={busy || !name.trim()}
            onClick={() => void create()}
          >
            保存
          </button>
        </div>
      )}
      {mode === 'external' && (
        <ExternalCalendarPanel onChanged={() => void changed()} />
      )}
      {error && <p className={errorCls}>{error}</p>}
    </DialogFrame>
  )
}

const RoleSelect = ({
  value,
  onChange,
  readOnly = false,
  allowedRoles = Object.keys(roleLabels) as Exclude<CalendarRole, 'none'>[],
}: {
  value: Exclude<CalendarRole, 'none'>
  onChange: (role: Exclude<CalendarRole, 'none'>) => void
  readOnly?: boolean
  allowedRoles?: Exclude<CalendarRole, 'none'>[]
}) => (
  <select
    className={inputCls}
    value={value}
    disabled={readOnly}
    onChange={(event) =>
      onChange(event.target.value as Exclude<CalendarRole, 'none'>)
    }
  >
    {allowedRoles.map((role) => (
      <option key={role} value={role}>
        {roleLabels[role]}
      </option>
    ))}
  </select>
)

export const CalendarSettingsDialog = ({
  calendar,
  onClose,
  onChanged,
}: {
  calendar: UnifiedCalendar
  onClose: () => void
  onChanged: () => void
}) => {
  const qc = useQueryClient()
  const [name, setName] = useState(calendar.display_name)
  const [description, setDescription] = useState(calendar.description)
  const [defaultAccess, setDefaultAccess] = useState(
    calendar.organization_default_access
  )
  const [color, setColor] = useState(calendar.color)
  const [addRole, setAddRole] =
    useState<Exclude<CalendarRole, 'none'>>('details')
  const [selected, setSelected] = useState<Map<string, string>>(new Map())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const { data: members = [] } = useQuery({
    queryKey: ['calendar', calendar.id, 'members'],
    queryFn: () => fetchCalendarMembers(calendar.id),
    enabled: calendar.capabilities.can_manage,
  })
  const refresh = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['calendar', 'unified'] }),
      qc.invalidateQueries({ queryKey: ['calendar', calendar.id, 'members'] }),
    ])
    onChanged()
  }
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    try {
      await fn()
      await refresh()
    } catch (reason) {
      setError(apiErrorMessage(reason))
    } finally {
      setBusy(false)
    }
  }
  return (
    <DialogFrame title="日历设置" onClose={onClose}>
      <div className={stackCls}>
        <label className={labelCls}>
          日历名称
          <input
            className={inputCls}
            disabled={calendar.kind === 'primary'}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          {calendar.kind === 'primary' && (
            <small className={mutedCls}>个人主日历名称跟随账号名称</small>
          )}
        </label>
        <label className={labelCls}>
          描述
          <textarea
            className={inputCls}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        <label className={labelCls}>
          我的显示颜色
          <input
            type="color"
            value={color}
            onChange={(e) => setColor(e.target.value)}
          />
        </label>
        <label className={labelCls}>
          组织内默认权限
          <select
            className={inputCls}
            value={defaultAccess}
            onChange={(e) =>
              setDefaultAccess(e.target.value as typeof defaultAccess)
            }
          >
            <option value="none">私密</option>
            <option value="free_busy">游客（仅忙闲）</option>
            <option value="details">订阅者（查看详情）</option>
          </select>
        </label>
        <p className={mutedCls}>
          组织外默认私密；已建立外部联系的人只能被单独授予只读权限。
        </p>
        <button
          type="button"
          className={primaryBtnCls}
          disabled={busy}
          onClick={() =>
            void act(async () => {
              await updateCalendar(calendar.id, {
                ...(calendar.kind === 'primary' ? {} : { name }),
                description,
                organization_default_access: defaultAccess,
              })
              await setCalendarSubscription(calendar.id, { color })
            })
          }
        >
          保存设置
        </button>
        <h3 className={sectionTitleCls}>共享人</h3>
        {members.map((member) => (
          <div key={member.id} className={rowCls}>
            <span className={growCls}>
              {member.user.full_name || member.user.short_name}
              {member.external ? '（外部联系人）' : ''}
            </span>
            <RoleSelect
              value={member.role}
              allowedRoles={
                calendar.kind === 'primary' || member.external
                  ? ['free_busy', 'details']
                  : undefined
              }
              onChange={(role) =>
                void act(() =>
                  updateCalendarMember(calendar.id, member.id, role)
                )
              }
            />
            <button
              type="button"
              className={dangerBtnCls}
              onClick={() =>
                void act(() => removeCalendarMember(calendar.id, member.id))
              }
            >
              移除
            </button>
          </div>
        ))}
        <RoleSelect
          value={addRole}
          onChange={setAddRole}
          allowedRoles={
            calendar.kind === 'primary' ? ['free_busy', 'details'] : undefined
          }
        />
        <DirectoryMultiPicker
          selected={selected}
          onToggle={(id, label) =>
            setSelected((current) => {
              const next = new Map(current)
              if (next.has(id)) next.delete(id)
              else next.set(id, label)
              return next
            })
          }
          includeExternal
          labels={{
            searchPlaceholder: '添加共享人',
            selectedTitle: `已选 ${selected.size} 人`,
            loading: '加载中',
            empty: '没有结果',
            loadMore: '加载更多',
          }}
        />
        <button
          type="button"
          className={secondaryBtnCls}
          disabled={busy || selected.size === 0}
          onClick={() =>
            void act(async () => {
              await Promise.all(
                [...selected.keys()].map((id) =>
                  addCalendarMember(calendar.id, id, addRole)
                )
              )
              setSelected(new Map())
            })
          }
        >
          添加共享人
        </button>
        {calendar.capabilities.can_delete && (
          <button
            type="button"
            className={dangerBtnCls}
            disabled={busy}
            onClick={() =>
              void act(async () => {
                await deleteCalendar(calendar.id)
                onClose()
              })
            }
          >
            删除日历（30 天内可恢复）
          </button>
        )}
        {error && <p className={errorCls}>{error}</p>}
      </div>
    </DialogFrame>
  )
}

export const CalendarShareDialog = ({
  calendar,
  onClose,
}: {
  calendar: UnifiedCalendar
  onClose: () => void
}) => {
  const [chat, setChat] = useState(false)
  const [error, setError] = useState('')
  const { data, refetch } = useQuery({
    queryKey: ['calendar', calendar.id, 'share-link'],
    queryFn: () => fetchCalendarShareLink(calendar.id),
  })
  const body = JSON.stringify({
    v: 1,
    calendar_id: calendar.id,
    name: calendar.display_name,
    owner_name: calendar.owner?.full_name || calendar.owner?.short_name || '',
    description: calendar.description,
    subscriber_count: calendar.subscriber_count,
    subscribe_url: data?.url || '',
  })
  if (chat && data)
    return (
      <ShareToChatDialog
        body={body}
        contentType="calendar-card"
        previewText={`分享日历：${calendar.display_name}`}
        errorMessage="分享日历失败"
        onClose={() => setChat(false)}
      />
    )
  return (
    <DialogFrame title="分享日历" onClose={onClose}>
      <div className={stackCls}>
        <p>分享只邀请对方订阅查看；编辑权限请在“日历设置 → 共享人”中授予。</p>
        {data && (
          <>
            <label className={labelCls}>
              日历链接
              <input className={inputCls} readOnly value={data.url} />
            </label>
            <div className={buttonRowCls}>
              <button
                type="button"
                className={primaryBtnCls}
                onClick={() => void navigator.clipboard.writeText(data.url)}
              >
                复制链接
              </button>
              <button
                type="button"
                className={secondaryBtnCls}
                onClick={() => setChat(true)}
              >
                分享至会话
              </button>
              <button
                type="button"
                className={dangerBtnCls}
                onClick={() =>
                  void resetCalendarShareLink(calendar.id)
                    .then(() => refetch())
                    .catch((reason) => setError(apiErrorMessage(reason)))
                }
              >
                重置链接
              </button>
            </div>
            <div className={qrCls}>
              <QRCodeSVG id="calendar-share-qr" value={data.url} size={220} />
              <span className={mutedCls}>
                Web 可打开；Android App Link 可直接预览并订阅。
              </span>
              <div className={buttonRowCls}>
                <button
                  type="button"
                  className={secondaryBtnCls}
                  onClick={() =>
                    void copyQrImage().catch((reason) =>
                      setError(apiErrorMessage(reason))
                    )
                  }
                >
                  复制二维码
                </button>
                <button
                  type="button"
                  className={secondaryBtnCls}
                  onClick={() => downloadQrImage(calendar.display_name)}
                >
                  下载二维码
                </button>
              </div>
            </div>
          </>
        )}
        {error && <p className={errorCls}>{error}</p>}
      </div>
    </DialogFrame>
  )
}

export const CalendarExportDialog = ({
  calendar,
  onClose,
}: {
  calendar: UnifiedCalendar
  onClose: () => void
}) => {
  const [range, setRange] = useState<'today' | 'week' | 'month' | 'custom'>(
    'week'
  )
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  return (
    <DialogFrame title="导出日历" onClose={onClose}>
      <div className={stackCls}>
        {(['today', 'week', 'month', 'custom'] as const).map((value) => (
          <label key={value} className={radioCls}>
            <input
              type="radio"
              checked={range === value}
              onChange={() => setRange(value)}
            />
            {
              { today: '今天', week: '本周', month: '本月', custom: '自定义' }[
                value
              ]
            }
          </label>
        ))}
        {range === 'custom' && (
          <div className={buttonRowCls}>
            <input
              type="date"
              className={inputCls}
              value={start}
              onChange={(e) => setStart(e.target.value)}
            />
            <input
              type="date"
              className={inputCls}
              value={end}
              onChange={(e) => setEnd(e.target.value)}
            />
          </div>
        )}
        <p className={mutedCls}>
          将异步生成 Docs 原生表格和 CSV
          静态快照；图片、内嵌表格与附件原文件不导出。
        </p>
        <button
          type="button"
          className={primaryBtnCls}
          disabled={busy || (range === 'custom' && (!start || !end))}
          onClick={() => {
            setBusy(true)
            setMessage('')
            const payload =
              range === 'custom'
                ? ({ range, timezone, start, end } as const)
                : ({ range, timezone } as const)
            void createCalendarExport(calendar.id, payload)
              .then(() =>
                setMessage('导出任务已提交，完成后日历助手会通知你。')
              )
              .catch((reason) => setMessage(apiErrorMessage(reason)))
              .finally(() => setBusy(false))
          }}
        >
          确定
        </button>
        {message && <p>{message}</p>}
      </div>
    </DialogFrame>
  )
}

const ExternalCalendarPanel = ({ onChanged }: { onChanged: () => void }) => {
  const qc = useQueryClient()
  const [error, setError] = useState('')
  const { data: accounts = [] } = useQuery({
    queryKey: ['calendar', 'external-accounts'],
    queryFn: fetchExternalCalendarAccounts,
  })
  const refresh = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['calendar', 'external-accounts'] }),
      qc.invalidateQueries({ queryKey: ['calendar', 'unified'] }),
    ])
    onChanged()
  }
  const connect = async (provider: 'google' | 'microsoft') => {
    try {
      const result = await authorizeExternalCalendar(provider)
      window.location.assign(result.authorization_url)
    } catch (reason) {
      setError(apiErrorMessage(reason))
    }
  }
  return (
    <div className={stackCls}>
      <div className={buttonRowCls}>
        <button
          type="button"
          className={primaryBtnCls}
          onClick={() => void connect('google')}
        >
          连接 Google Calendar
        </button>
        <button
          type="button"
          className={primaryBtnCls}
          onClick={() => void connect('microsoft')}
        >
          连接 Microsoft 365 / Outlook.com
        </button>
      </div>
      {accounts.map((account) => (
        <ProviderAccountRow
          key={account.id}
          account={account}
          onChanged={() => void refresh()}
        />
      ))}
      {error && <p className={errorCls}>{error}</p>}
    </div>
  )
}

const ProviderAccountRow = ({
  account,
  onChanged,
}: {
  account: ExternalCalendarAccount
  onChanged: () => void
}) => {
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(account.bindings.map((row) => row.remote_calendar_id))
  )
  const [error, setError] = useState('')
  const { data: calendars = [] } = useQuery({
    queryKey: ['calendar', 'provider-calendars', account.id],
    queryFn: () => fetchProviderCalendars(account.id),
  })
  return (
    <section className={accountCls}>
      <strong>{account.email || account.provider}</strong>
      <span className={mutedCls}>{account.status}</span>
      {calendars.map((calendar) => (
        <label key={calendar.id} className={radioCls}>
          <input
            type="checkbox"
            checked={selected.has(calendar.id)}
            onChange={() =>
              setSelected((current) => {
                const next = new Set(current)
                if (next.has(calendar.id)) next.delete(calendar.id)
                else next.add(calendar.id)
                return next
              })
            }
          />
          {calendar.name} {calendar.primary ? '（主日历）' : ''}
        </label>
      ))}
      <div className={buttonRowCls}>
        <button
          type="button"
          className={primaryBtnCls}
          disabled={selected.size === 0}
          onClick={() =>
            void selectProviderCalendars(account.id, [...selected])
              .then(onChanged)
              .catch((reason) => setError(apiErrorMessage(reason)))
          }
        >
          保存同步范围
        </button>
        <button
          type="button"
          className={secondaryBtnCls}
          onClick={() =>
            void syncExternalCalendarAccount(account.id).catch((reason) =>
              setError(apiErrorMessage(reason))
            )
          }
        >
          立即同步
        </button>
        <button
          type="button"
          className={dangerBtnCls}
          onClick={() =>
            void disconnectExternalCalendarAccount(account.id)
              .then(onChanged)
              .catch((reason) => setError(apiErrorMessage(reason)))
          }
        >
          断开连接
        </button>
      </div>
      {error && <p className={errorCls}>{error}</p>}
    </section>
  )
}

const headerCls = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '1rem',
  borderBottom: '1px solid token(colors.greyscale.200)',
})
const titleCls = css({ margin: 0, fontSize: '1.1rem', fontWeight: 700 })
const bodyCls = css({ padding: '1rem', overflowY: 'auto' })
const stackCls = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.75rem',
})
const tabsCls = css({
  display: 'flex',
  alignItems: 'center',
  gap: '0.35rem',
  borderBottom: '1px solid token(colors.greyscale.200)',
  marginBottom: '0.75rem',
})
const tabCls = css({
  border: 0,
  background: 'transparent',
  padding: '0.65rem',
  color: 'greyscale.600',
  cursor: 'pointer',
})
const activeTabCls = css({
  border: 0,
  borderBottom: '2px solid token(colors.primary.500)',
  background: 'transparent',
  padding: '0.65rem',
  color: 'primary.600',
  cursor: 'pointer',
})
const labelCls = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.3rem',
  color: 'greyscale.700',
  fontSize: '0.85rem',
})
const inputCls = css({
  width: '100%',
  border: '1px solid token(colors.greyscale.300)',
  borderRadius: '0.4rem',
  padding: '0.55rem 0.65rem',
  background: 'greyscale.000',
  color: 'greyscale.900',
})
const rowCls = css({
  display: 'flex',
  alignItems: 'center',
  gap: '0.6rem',
  padding: '0.55rem',
  borderRadius: '0.4rem',
  _hover: { background: 'greyscale.50' },
})
const growCls = css({
  minWidth: 0,
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
})
const dotCls = css({
  width: '0.7rem',
  height: '0.7rem',
  borderRadius: '0.2rem',
  flexShrink: 0,
})
const mutedCls = css({ color: 'greyscale.500', fontSize: '0.78rem' })
const errorCls = css({ color: 'danger.600', fontSize: '0.82rem' })
const buttonRowCls = css({
  display: 'flex',
  gap: '0.5rem',
  flexWrap: 'wrap',
  alignItems: 'center',
})
const primaryBtnCls = css({
  border: 0,
  borderRadius: '0.4rem',
  background: 'primary.500',
  color: 'white',
  padding: '0.5rem 0.8rem',
  cursor: 'pointer',
  _disabled: { opacity: 0.5, cursor: 'not-allowed' },
})
const secondaryBtnCls = css({
  border: '1px solid token(colors.greyscale.300)',
  borderRadius: '0.4rem',
  background: 'greyscale.000',
  color: 'greyscale.800',
  padding: '0.5rem 0.8rem',
  cursor: 'pointer',
})
const dangerBtnCls = css({
  border: '1px solid token(colors.danger.300)',
  borderRadius: '0.4rem',
  background: 'greyscale.000',
  color: 'danger.600',
  padding: '0.5rem 0.8rem',
  cursor: 'pointer',
})
const sectionTitleCls = css({ margin: '0.4rem 0 0', fontSize: '0.95rem' })
const radioCls = css({
  display: 'flex',
  alignItems: 'center',
  gap: '0.45rem',
  fontSize: '0.85rem',
})
const qrCls = css({
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: '0.6rem',
  padding: '1rem',
})
const accountCls = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.55rem',
  border: '1px solid token(colors.greyscale.200)',
  borderRadius: '0.5rem',
  padding: '0.75rem',
})
