import { ReactNode, useEffect, useMemo, useState } from 'react'

import { useTranslation } from 'react-i18next'
import { useTitle } from 'hoofd'
import ReactMarkdown from 'react-markdown'
import { useParams } from 'wouter'

import { Center, VStack } from '@/styled-system/jsx'
import { css } from '@/styled-system/css'
import { token } from '@/styled-system/tokens'
import { ErrorScreen } from '@/components/ErrorScreen'
import { LoadingScreen } from '@/components/LoadingScreen'
import { StateHint } from '@/components/StateHint'
import { Screen } from '@/layout/Screen'
import { Button, Field, Text } from '@/primitives'
import { MeetingDetailHeader } from '../components/MeetingDetailHeader'
import { Select } from '@/primitives/Select'
import { Tabs, Tab, TabList, TabPanel } from '@/primitives/Tabs'
import { UserAware, useUser } from '@/features/auth'
import { useInlineEditFocus } from '@/hooks/useInlineEditFocus'
import { useConfig } from '@/api/useConfig'
import { formatClock, formatDateTime } from '../recordDateTime'
import { RoomRecordSummaries } from '../components/RecordSummaryPanel'

import {
  useCreateActionItemTask,
  useMeetingActionItems,
  useMeetingActionItemAssignees,
  useMeetingRoom,
  useMeetingSummary,
  useMeetingTranscripts,
  usePatchActionItem,
  usePatchSummary,
  useRegenerateSummary,
} from '../api/fetchMeeting'
import { ApiActionItem } from '../api/ApiMeeting'

const markdownBodyStyle = css({
  textStyle: 'bodyLarge',
  // 纪要正文的 1.7 是长文阅读行距 —— 内容决定的几何,不是排版节奏,
  // 与 TranscriptSegment 的逐字稿同一口径,故照旧保留(放在 textStyle 之后才压得住)。
  lineHeight: '1.7',
  '& > :first-child': { marginTop: 0 },
  '& h1, & h2, & h3, & h4': {
    fontWeight: 'semibold',
    marginTop: '1.25rem',
    marginBottom: '0.5rem',
    // 标题行距固定 1.3:多行标题要与上段贴紧,不取字阶自带的宽松行高。
    lineHeight: '1.3',
  },
  // textStyle 会一并写入 fontWeight / lineHeight,所以 h2/h3/h4 把 semibold 与 1.3
  // 排在它后面压回来(libraryStyles / RecordSummaryPanel 也是这个写法)。
  '& h2': {
    textStyle: 'titleLarge',
    fontWeight: 'semibold',
    lineHeight: '1.3',
  },
  '& h3': {
    textStyle: 'titleMedium',
    fontWeight: 'semibold',
    lineHeight: '1.3',
  },
  '& h4': {
    textStyle: 'bodyLarge',
    fontWeight: 'semibold',
    lineHeight: '1.3',
  },
  '& p': { margin: '0.5rem 0' },
  '& ul, & ol': { margin: '0.25rem 0 0.5rem 1.5rem' },
  '& ul': { listStyleType: 'disc' },
  '& ol': { listStyleType: 'decimal' },
  '& code': {
    backgroundColor: 'surface.muted',
    padding: '0.05rem 0.25rem',
    borderRadius: 'field',
    // textStyle 自带 sans 字体族,等宽要写在它后面才不被覆盖。
    textStyle: 'bodyMedium',
    fontFamily: 'monospace',
  },
  '& a': { color: 'text.link', textDecoration: 'underline' },
})

const APP_TITLE = import.meta.env.VITE_APP_TITLE ?? ''

// ---------------------------------------------------------------------------
// Tab bodies
// ---------------------------------------------------------------------------

const SummaryTab = ({ roomId }: { roomId: string }) => {
  const { t } = useTranslation('meetings')
  const { user } = useUser()
  const { data, isLoading, isError, error } = useMeetingSummary(roomId)
  const { data: room } = useMeetingRoom(roomId)
  const regen = useRegenerateSummary(roomId)
  const patch = usePatchSummary(roomId)
  // M2 可编辑三态:展示(编辑版优先)/ 查看 AI 原文 / 编辑中。
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [viewAi, setViewAi] = useState(false)
  // 点「编辑」= 要动手改这段纪要,焦点得直接落进编辑框;退出时还给「编辑」按钮
  // (它在编辑期间被卸载,回来是新节点,所以不能用 useRestoreFocus)。
  const { fieldRef, triggerRef } = useInlineEditFocus<
    HTMLTextAreaElement,
    HTMLButtonElement
  >(editing)

  // 拍板 #1:编辑权限首期仅房间 OWNER/ADMIN(accesses 仅对管理者返回,
  // 普通参会者拿不到该数组,自然收敛为不可编辑)。
  const canEdit =
    !!user &&
    !!room?.accesses?.some(
      (a) =>
        a.user.id === user.id &&
        (a.role === 'owner' || a.role === 'administrator')
    )

  const RegenButton = () => (
    <Button
      variant="tertiary"
      size="sm"
      isDisabled={regen.isPending}
      onPress={() => regen.mutate()}
    >
      {regen.isPending ? t('summary.regenerating') : t('summary.regenerate')}
    </Button>
  )

  if (isLoading) return <StateHint state="loading">{t('loading')}</StateHint>
  // 404 = no summary yet — friendly empty state with regen button.
  if (error?.statusCode === 404)
    return <StateHint action={<RegenButton />}>{t('summary.empty')}</StateHint>
  if (isError || !data)
    return <StateHint state="error">{t('error.loadFailed')}</StateHint>

  const effective = data.effective_content ?? data.content
  const shown = viewAi ? data.content : effective

  const save = () => {
    patch.mutate(draft, {
      onSuccess: () => setEditing(false),
    })
  }
  const restoreAi = () => {
    patch.mutate('', { onSuccess: () => setViewAi(false) })
  }

  return (
    <div
      className={css({
        display: 'flex',
        flexDirection: 'column',
        gap: '0.75rem',
      })}
    >
      <div
        className={css({
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
          justifyContent: 'flex-end',
          flexWrap: 'wrap',
        })}
      >
        {data.is_edited && (
          <span
            className={css({
              textStyle: 'labelMedium',
              color: 'text.secondary',
              backgroundColor: 'surface.muted',
              borderRadius: 'pill',
              padding: '0.125rem 0.5rem',
            })}
          >
            {t('summary.editedBadge')}
          </span>
        )}
        {canEdit && !editing && (
          <Button
            variant="tertiary"
            size="sm"
            ref={triggerRef}
            onPress={() => {
              setDraft(effective)
              setViewAi(false)
              setEditing(true)
            }}
          >
            {t('summary.edit')}
          </Button>
        )}
        <RegenButton />
      </div>

      {/* AI 原文在编辑后又更新了 → 提示 + 对照/恢复入口(D3 语义)。 */}
      {data.is_edited && !editing && (
        <div
          className={css({
            display: 'flex',
            alignItems: 'center',
            gap: '0.75rem',
            flexWrap: 'wrap',
            textStyle: 'bodySmall',
            color: 'text.secondary',
            backgroundColor: 'surface.canvas',
            border: '1px solid token(colors.border.subtle)',
            borderRadius: 'control',
            padding: '0.5rem 0.75rem',
          })}
        >
          <span>
            {data.ai_updated_after_edit
              ? t('summary.aiUpdatedAfterEdit')
              : t('summary.showingEdited')}
          </span>
          <Button
            variant="tertiary"
            size="sm"
            onPress={() => setViewAi((v) => !v)}
          >
            {viewAi ? t('summary.backToEdited') : t('summary.viewAi')}
          </Button>
          {canEdit && (
            <Button
              variant="tertiary"
              size="sm"
              isDisabled={patch.isPending}
              onPress={restoreAi}
            >
              {t('summary.restoreAi')}
            </Button>
          )}
        </div>
      )}

      {editing ? (
        <div
          className={css({
            display: 'flex',
            flexDirection: 'column',
            gap: '0.5rem',
          })}
        >
          <textarea
            ref={fieldRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={18}
            data-testid="summary-editor"
            className={css({
              width: '100%',
              // 编辑器的 1.6 是长文改写的阅读行距,同样属于内容决定的几何;
              // textStyle 自带字体族与行高,等宽与 1.6 都要排在它后面。
              textStyle: 'bodyMedium',
              fontFamily: 'monospace',
              lineHeight: 1.6,
              padding: '0.75rem',
              border: '1px solid token(colors.border.default)',
              borderRadius: 'control',
              resize: 'vertical',
            })}
          />
          <div
            className={css({
              display: 'flex',
              gap: '0.5rem',
              justifyContent: 'flex-end',
            })}
          >
            <Button
              variant="tertiary"
              size="sm"
              onPress={() => setEditing(false)}
            >
              {t('summary.cancelEdit')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              isDisabled={patch.isPending}
              onPress={save}
            >
              {patch.isPending ? t('summary.saving') : t('summary.save')}
            </Button>
          </div>
          {patch.isError && (
            <Text variant="note">{t('summary.saveFailed')}</Text>
          )}
        </div>
      ) : data.status === 'failed' || !shown ? (
        <StateHint>{t('summary.empty')}</StateHint>
      ) : (
        <div className={markdownBodyStyle}>
          <ReactMarkdown>{shown}</ReactMarkdown>
        </div>
      )}
    </div>
  )
}

/** 纪要闭环 D2:智能章节板块(时间轴 + 标题 + 要点);M2 拍板 #3:点击带时间
 * 窗的章节 → 切到转写 Tab 并滚动定位到对应时刻。 */
const ChaptersTab = ({
  roomId,
  onJump,
}: {
  roomId: string
  onJump?: (startIso: string) => void
}) => {
  const { t } = useTranslation('meetings')
  const { data, isLoading, error } = useMeetingSummary(roomId)

  if (isLoading) return <StateHint state="loading">{t('loading')}</StateHint>
  if (error?.statusCode === 404)
    return <StateHint>{t('chapters.empty')}</StateHint>
  if (error) return <StateHint state="error">{t('error.loadFailed')}</StateHint>
  const chapters = data?.chapters ?? []
  if (chapters.length === 0) return <StateHint>{t('chapters.empty')}</StateHint>

  const fmt = (iso: string | null) => formatClock(iso) ?? ''

  return (
    <ol
      className={css({
        listStyle: 'none',
        padding: 0,
        margin: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: '0.875rem',
      })}
    >
      {chapters.map((chapter) => {
        const jumpable = !!onJump && !!chapter.started_at
        return (
          <li key={chapter.id}>
            <button
              type="button"
              disabled={!jumpable}
              onClick={
                jumpable
                  ? () => onJump!(chapter.started_at as string)
                  : undefined
              }
              title={jumpable ? t('chapters.jumpHint') : undefined}
              className={css({
                display: 'flex',
                width: '100%',
                gap: '0.75rem',
                alignItems: 'flex-start',
                borderRadius: 'control',
                border: 0,
                background: 'transparent',
                textAlign: 'left',
                padding: '0.25rem 0.375rem',
                cursor: jumpable ? 'pointer' : 'default',
                _hover: jumpable ? { backgroundColor: 'surface.canvas' } : {},
              })}
            >
              <span
                className={css({
                  flexShrink: 0,
                  minWidth: '7.5rem',
                  // textStyle 自带 sans 字体族,等宽时间戳要写在它后面。
                  textStyle: 'bodySmall',
                  fontFamily: 'monospace',
                  color: 'text.secondary',
                  paddingTop: '0.125rem',
                })}
              >
                {chapter.started_at
                  ? `${fmt(chapter.started_at)}${chapter.ended_at ? ` – ${fmt(chapter.ended_at)}` : ''}`
                  : '—'}
              </span>
              <div>
                <Text bold>{chapter.title}</Text>
                {chapter.digest && (
                  <Text
                    variant="note"
                    className={css({ marginTop: '0.125rem', display: 'block' })}
                  >
                    {chapter.digest}
                  </Text>
                )}
              </div>
            </button>
          </li>
        )
      })}
    </ol>
  )
}

const ActionItemsTab = ({ roomId }: { roomId: string }) => {
  const { t } = useTranslation('meetings')
  const { data, isLoading, isError } = useMeetingActionItems(roomId)
  const patch = usePatchActionItem(roomId)
  const createTask = useCreateActionItemTask(roomId)
  const canManage = data?.some((item) => item.can_manage) ?? false
  const {
    data: assignees = [],
    isLoading: assigneesLoading,
    isError: assigneesError,
  } = useMeetingActionItemAssignees(roomId, canManage)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftContent, setDraftContent] = useState('')
  const [draftAssigneeId, setDraftAssigneeId] = useState<string | null>(null)
  const [draftDueAt, setDraftDueAt] = useState('')

  const toLocalDateTime = (value: string | null) => {
    if (!value) return ''
    const date = new Date(value)
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
    return local.toISOString().slice(0, 16)
  }

  const beginEdit = (item: ApiActionItem) => {
    patch.reset()
    setEditingId(item.id)
    setDraftContent(item.content)
    setDraftAssigneeId(item.assignee?.id ?? null)
    setDraftDueAt(toLocalDateTime(item.due_at))
  }

  const cancelEdit = () => {
    patch.reset()
    setEditingId(null)
  }

  const saveEdit = (item: ApiActionItem) => {
    const content = draftContent.trim()
    if (!content) return
    patch.mutate(
      {
        itemId: item.id,
        patch: {
          content,
          assignee_id: draftAssigneeId,
          due_at: draftDueAt ? new Date(draftDueAt).toISOString() : null,
        },
      },
      { onSuccess: () => setEditingId(null) }
    )
  }

  if (isLoading) return <StateHint state="loading">{t('loading')}</StateHint>
  if (isError)
    return <StateHint state="error">{t('error.loadFailed')}</StateHint>
  if (!data || data.length === 0)
    return <StateHint>{t('actionItems.empty')}</StateHint>

  return (
    <ul
      className={css({
        listStyle: 'none',
        padding: 0,
        margin: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: '0.75rem',
      })}
    >
      {data.map((item) => (
        <li
          key={item.id}
          className={css({
            border: '1px solid',
            borderColor: 'border.default',
            borderRadius: 'control',
            padding: '0.75rem 1rem',
            backgroundColor: item.is_completed
              ? 'surface.muted'
              : 'surface.default',
            opacity: item.is_completed ? 0.7 : 1,
          })}
        >
          {editingId === item.id ? (
            <div
              className={css({
                display: 'flex',
                flexDirection: 'column',
                gap: '0.75rem',
              })}
            >
              <Field
                type="text"
                label={t('actionItems.content')}
                value={draftContent}
                onChange={setDraftContent}
                isRequired
                isDisabled={patch.isPending}
                wrapperProps={{ noMargin: true, fullWidth: true }}
              />
              <Select
                label={t('actionItems.assignee')}
                aria-label={t('actionItems.assignee')}
                items={[
                  {
                    value: '__unassigned__',
                    label: t('actionItems.unassigned'),
                  },
                  ...assignees.map((user) => ({
                    value: user.id,
                    label:
                      user.full_name ||
                      user.short_name ||
                      user.email ||
                      user.id,
                  })),
                ]}
                selectedKey={draftAssigneeId ?? '__unassigned__'}
                onSelectionChange={(key) =>
                  setDraftAssigneeId(
                    key === '__unassigned__' ? null : String(key)
                  )
                }
                isDisabled={patch.isPending || assigneesLoading}
              />
              {assigneesError && (
                <Text variant="note">{t('actionItems.assigneesFailed')}</Text>
              )}
              <label
                className={css({
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '0.25rem',
                  textStyle: 'bodyMedium',
                })}
              >
                {t('actionItems.dueAt')}
                <input
                  type="datetime-local"
                  value={draftDueAt}
                  onChange={(event) => setDraftDueAt(event.target.value)}
                  disabled={patch.isPending}
                  className={css({
                    width: 'full',
                    minHeight: 'controlHeight.compact',
                    paddingX: '0.5rem',
                    border: '1px solid',
                    borderColor: 'border.strong',
                    color: 'text.primary',
                    borderRadius: 'field',
                  })}
                />
              </label>
              {patch.isError && (
                <Text variant="note">{t('actionItems.updateFailed')}</Text>
              )}
              <div
                className={css({
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: '0.5rem',
                })}
              >
                <Button
                  size="sm"
                  variant="secondary"
                  isDisabled={patch.isPending || !draftContent.trim()}
                  onPress={() => saveEdit(item)}
                >
                  {patch.isPending
                    ? t('actionItems.saving')
                    : t('actionItems.save')}
                </Button>
                <Button
                  size="sm"
                  variant="tertiary"
                  isDisabled={patch.isPending}
                  onPress={cancelEdit}
                >
                  {t('actionItems.cancelEdit')}
                </Button>
              </div>
            </div>
          ) : (
            <>
              <div
                className={css({
                  display: 'flex',
                  alignItems: 'flex-start',
                  justifyContent: 'space-between',
                  gap: '0.75rem',
                  marginBottom: '0.25rem',
                })}
              >
                <span className={css({ fontWeight: 'medium' })}>
                  {item.content}
                </span>
                <span
                  className={css({
                    flexShrink: 0,
                    borderRadius: 'pill',
                    padding: '0.125rem 0.5rem',
                    textStyle: 'labelMedium',
                    // 状态色走 status.success 的 container/container-text 成对角色:
                    // 原先的 success.100/700 是不随主题翻转的原始数字档,深色下会糊。
                    color:
                      item.status === 'completed'
                        ? 'status.success.container-text'
                        : 'text.secondary',
                    backgroundColor:
                      item.status === 'completed'
                        ? 'status.success.container'
                        : 'surface.muted',
                  })}
                >
                  {t(`actionItems.status.${item.status}`)}
                </span>
              </div>
              <div
                className={css({
                  textStyle: 'bodyMedium',
                  color: 'text.secondary',
                  display: 'flex',
                  gap: '1rem',
                  flexWrap: 'wrap',
                })}
              >
                {(item.assignee || item.owner_text) && (
                  <span>
                    {t('actionItems.owner')}:{' '}
                    {item.assignee?.full_name ||
                      item.assignee?.short_name ||
                      item.owner_text}
                  </span>
                )}
                {(item.due_at || item.due_text) && (
                  <span>
                    {t('actionItems.due')}:{' '}
                    {item.due_at
                      ? new Intl.DateTimeFormat(undefined, {
                          dateStyle: 'medium',
                        }).format(new Date(item.due_at))
                      : item.due_text}
                  </span>
                )}
              </div>
              {(item.can_update_status || item.can_manage) && (
                <div
                  className={css({
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: '0.5rem',
                    marginTop: '0.75rem',
                  })}
                >
                  {item.can_manage && (
                    <Button
                      size="sm"
                      variant="tertiary"
                      isDisabled={patch.isPending || editingId !== null}
                      onPress={() => beginEdit(item)}
                    >
                      {t('actionItems.edit')}
                    </Button>
                  )}
                  {item.task_id && (
                    <span
                      className={css({
                        alignSelf: 'center',
                        // 成功文案:status 组只给了 container/container-text 这对前景档,
                        // 单行文字取后者(浅色深绿,压白底约 9.4:1)。
                        color: 'status.success.container-text',
                        textStyle: 'bodyMedium',
                      })}
                    >
                      {t('actionItems.taskCreated')}
                    </span>
                  )}
                  {item.status === 'confirmed' &&
                    item.can_manage &&
                    !item.task_id && (
                      <>
                        <Button
                          size="sm"
                          variant="secondary"
                          isDisabled={
                            patch.isPending ||
                            createTask.isPending ||
                            !item.assignee
                          }
                          onPress={() => {
                            createTask.reset()
                            createTask.mutate({ itemId: item.id })
                          }}
                        >
                          {createTask.isPending &&
                          createTask.variables?.itemId === item.id
                            ? t('actionItems.creatingTask')
                            : t('actionItems.createTask')}
                        </Button>
                        {!item.assignee && (
                          <Text variant="note">
                            {t('actionItems.assignBeforeTask')}
                          </Text>
                        )}
                        {createTask.isError &&
                          createTask.variables?.itemId === item.id && (
                            <Text variant="note">
                              {t('actionItems.createTaskFailed')}
                            </Text>
                          )}
                      </>
                    )}
                  {item.status === 'proposed' && item.can_update_status && (
                    <Button
                      size="sm"
                      variant="secondary"
                      isDisabled={patch.isPending}
                      onPress={() =>
                        patch.mutate({
                          itemId: item.id,
                          patch: { status: 'confirmed' },
                        })
                      }
                    >
                      {t('actionItems.confirm')}
                    </Button>
                  )}
                  {item.status === 'confirmed' && item.can_update_status && (
                    <Button
                      size="sm"
                      variant="secondary"
                      isDisabled={patch.isPending}
                      onPress={() =>
                        patch.mutate({
                          itemId: item.id,
                          patch: { status: 'completed' },
                        })
                      }
                    >
                      {t('actionItems.complete')}
                    </Button>
                  )}
                  {item.status === 'completed' && item.can_update_status && (
                    <Button
                      size="sm"
                      variant="tertiary"
                      isDisabled={patch.isPending}
                      onPress={() =>
                        patch.mutate({
                          itemId: item.id,
                          patch: { status: 'confirmed' },
                        })
                      }
                    >
                      {t('actionItems.reopen')}
                    </Button>
                  )}
                  {item.status === 'dismissed' && item.can_manage && (
                    <Button
                      size="sm"
                      variant="tertiary"
                      isDisabled={patch.isPending}
                      onPress={() =>
                        patch.mutate({
                          itemId: item.id,
                          patch: { status: 'proposed' },
                        })
                      }
                    >
                      {t('actionItems.restore')}
                    </Button>
                  )}
                  {(item.status === 'proposed' ||
                    item.status === 'confirmed') &&
                    item.can_manage && (
                      <Button
                        size="sm"
                        variant="tertiary"
                        isDisabled={patch.isPending}
                        onPress={() =>
                          patch.mutate({
                            itemId: item.id,
                            patch: { status: 'dismissed' },
                          })
                        }
                      >
                        {t('actionItems.dismiss')}
                      </Button>
                    )}
                </div>
              )}
            </>
          )}
        </li>
      ))}
    </ul>
  )
}

const TranscriptTab = ({
  roomId,
  jumpTo,
  onJumpDone,
}: {
  roomId: string
  /** 章节跳转目标时刻(ISO);滚动到第一条不早于该时刻的转写并高亮。 */
  jumpTo?: string | null
  onJumpDone?: () => void
}) => {
  const { t, i18n } = useTranslation('meetings')
  const { data, isLoading, isError } = useMeetingTranscripts(roomId)
  const [flashId, setFlashId] = useState<string | null>(null)

  // 拍板 #3 章节→转写:数据就绪 + 目标存在时滚动定位,高亮 2s 后消费。
  useEffect(() => {
    if (!jumpTo || !data || data.length === 0) return
    const targetMs = new Date(jumpTo).getTime()
    const row =
      data.find((r) => new Date(r.started_at).getTime() >= targetMs) ??
      data[data.length - 1]
    const el = document.getElementById(`transcript-row-${row.id}`)
    if (el) {
      el.scrollIntoView({ block: 'center' })
      setFlashId(row.id)
      const timer = setTimeout(() => setFlashId(null), 2000)
      onJumpDone?.()
      return () => clearTimeout(timer)
    }
    onJumpDone?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpTo, data])

  if (isLoading) return <StateHint state="loading">{t('loading')}</StateHint>
  if (isError)
    return <StateHint state="error">{t('error.loadFailed')}</StateHint>
  if (!data || data.length === 0)
    return <StateHint>{t('transcript.empty')}</StateHint>

  const userLang = i18n.language.toLowerCase().split('-')[0]

  return (
    <div
      className={css({
        display: 'flex',
        flexDirection: 'column',
        gap: '0.5rem',
      })}
    >
      {data.map((row) => {
        const ts = formatClock(row.started_at)
        const speaker = row.speaker_name || row.speaker_identity.slice(0, 12)
        const translationKey = Object.keys(row.translations || {}).find(
          (k) => k.toLowerCase().split('-')[0] === userLang
        )
        const translation = translationKey
          ? row.translations[translationKey]
          : null
        const showTranslation =
          translation && row.language.toLowerCase().split('-')[0] !== userLang
        return (
          <div
            key={row.id}
            id={`transcript-row-${row.id}`}
            className={css({
              borderLeft: '3px solid',
              borderColor: 'border.default',
              paddingLeft: '0.75rem',
              paddingY: '0.25rem',
              transition: 'background-color 0.6s ease',
            })}
            // 章节跳转命中行的高亮:与选中态同源(action.selected.bg 随主题翻转),
            // 2s 后由 flashId 消费掉,所以只能走内联 style 的运行时 token。
            style={
              flashId === row.id
                ? { backgroundColor: token('colors.action.selected.bg') }
                : undefined
            }
          >
            <div
              className={css({
                textStyle: 'bodySmall',
                color: 'text.secondary',
              })}
            >
              {ts} · {speaker}
            </div>
            <div>{row.text}</div>
            {showTranslation && (
              <div
                className={css({
                  fontStyle: 'italic',
                  color: 'text.secondary',
                  textStyle: 'bodyMedium',
                  marginTop: '0.125rem',
                })}
              >
                {translation}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

const InfoRow = ({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) => (
  <div
    className={css({
      display: 'flex',
      gap: '1rem',
      padding: '0.6rem 0',
      borderBottom: '1px solid',
      borderColor: 'border.subtle',
      alignItems: 'baseline',
    })}
  >
    <div
      className={css({
        width: '5.5rem',
        flexShrink: 0,
        color: 'text.secondary',
        textStyle: 'bodyMedium',
      })}
    >
      {label}
    </div>
    <div
      className={css({
        flex: 1,
        textStyle: 'bodyLarge',
        wordBreak: 'break-word',
      })}
    >
      {children}
    </div>
  </div>
)

const MeetingInfoTab = ({ roomId }: { roomId: string }) => {
  const { t } = useTranslation('meetings')
  const { data, isLoading, isError } = useMeetingRoom(roomId)
  // Attendees: `accesses` only holds room *members* (owner + explicitly
  // added) — guests who join via link never get an access row, so a 2-person
  // call shows 1. The reliable "who was actually here" signal is the set of
  // distinct transcript speakers; fall back to members when no transcript.
  const { data: transcripts } = useMeetingTranscripts(roomId)
  const speakerNames = useMemo(() => {
    const seen = new Set<string>()
    const out: string[] = []
    for (const row of transcripts ?? []) {
      const name = row.speaker_name || row.speaker_identity.slice(0, 12)
      if (name && !seen.has(name)) {
        seen.add(name)
        out.push(name)
      }
    }
    return out
  }, [transcripts])

  if (isLoading) return <StateHint state="loading">{t('loading')}</StateHint>
  if (isError || !data)
    return <StateHint state="error">{t('error.loadFailed')}</StateHint>

  const start = formatDateTime(data.created_at)
  const end = data.closed_at ? formatDateTime(data.closed_at) : null
  const timeText = end
    ? `${start} – ${end}`
    : `${start}（${t('info.ongoing')}）`

  const memberNames = (data.accesses ?? []).map(
    (a) => a.user.full_name || a.user.short_name || a.user.email || '—'
  )
  const participantNames = speakerNames.length > 0 ? speakerNames : memberNames

  return (
    <div className={css({ display: 'flex', flexDirection: 'column' })}>
      <InfoRow label={t('info.name')}>
        {data.name || t('home.untitled')}
      </InfoRow>
      <InfoRow label={t('info.time')}>{timeText}</InfoRow>
      <InfoRow label={t('info.code')}>{data.slug || t('info.empty')}</InfoRow>
      <InfoRow label={t('info.owner')}>{data.owner || t('info.empty')}</InfoRow>
      <InfoRow label={t('info.participants')}>
        {participantNames.length === 0 ? (
          t('info.empty')
        ) : (
          <ul
            className={css({
              listStyle: 'none',
              padding: 0,
              margin: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: '0.25rem',
            })}
          >
            {participantNames.map((name, i) => (
              <li key={i}>{name}</li>
            ))}
          </ul>
        )}
      </InfoRow>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Route component
// ---------------------------------------------------------------------------

function MeetingPageHeader({
  roomId,
  viewerId,
}: {
  roomId: string
  viewerId?: string
}) {
  const { t } = useTranslation('meetings')
  const query = useMeetingRoom(roomId)
  return (
    <MeetingDetailHeader
      viewerId={viewerId}
      listHref="/meeting"
      listLabel={t('library.video')}
      title={
        query.isError
          ? t('error.loadFailed')
          : query.data?.name ||
            t(query.isPending ? 'loading' : 'library.untitled')
      }
    />
  )
}

export const MeetingDetail = () => {
  const { t } = useTranslation('meetings')
  const { roomId } = useParams<{ roomId: string }>()
  const { isLoggedIn, isLoading: isAuthLoading, user } = useUser()
  const { data: config } = useConfig()
  const recordAiEnabled = !!config?.meeting_records?.enabled
  // 拍板 #3 章节→转写跳转:Tabs 受控,章节点击切 Tab 并带上目标时刻。
  const [tabKey, setTabKey] = useState<string>('info')
  const [transcriptJump, setTranscriptJump] = useState<string | null>(null)

  const pageTitle = useMemo(() => `${APP_TITLE} - ${t('pageTitle')}`, [t])
  useTitle(pageTitle)

  if (isLoggedIn === undefined || isAuthLoading) return <LoadingScreen />
  if (!isLoggedIn)
    return <ErrorScreen title={t('auth.title')} body={t('auth.body')} />
  if (!roomId)
    return <ErrorScreen title={t('error.title')} body={t('error.body')} />

  return (
    <UserAware>
      <Screen layout="centered" footer={false}>
        <Center>
          <VStack
            className={css({
              width: '100%',
              maxWidth: '880px',
              alignItems: 'stretch',
              padding: '1rem',
            })}
          >
            <MeetingPageHeader roomId={roomId} viewerId={user?.id} />

            <Tabs
              selectedKey={tabKey}
              onSelectionChange={(key) => setTabKey(String(key))}
              className={css({ width: '100%' })}
            >
              <TabList aria-label={t('tabs.label')}>
                <Tab id="info">{t('tabs.info')}</Tab>
                <Tab id="summary">{t('tabs.summary')}</Tab>
                {recordAiEnabled && (
                  <Tab id="record-ai">{t('recordAi.tab')}</Tab>
                )}
                <Tab id="action-items">{t('tabs.actionItems')}</Tab>
                <Tab id="chapters">{t('tabs.chapters')}</Tab>
                <Tab id="transcript">{t('tabs.transcript')}</Tab>
              </TabList>
              <TabPanel id="info" padding="md">
                <MeetingInfoTab roomId={roomId} />
              </TabPanel>
              <TabPanel id="summary" padding="md">
                <SummaryTab roomId={roomId} />
              </TabPanel>
              {recordAiEnabled && user && (
                <TabPanel id="record-ai" padding="md">
                  <RoomRecordSummaries
                    key={`${user.id}:${roomId}`}
                    viewerId={user.id}
                    roomId={roomId}
                  />
                </TabPanel>
              )}
              <TabPanel id="action-items" padding="md">
                <ActionItemsTab roomId={roomId} />
              </TabPanel>
              <TabPanel id="chapters" padding="md">
                <ChaptersTab
                  roomId={roomId}
                  onJump={(startIso) => {
                    setTranscriptJump(startIso)
                    setTabKey('transcript')
                  }}
                />
              </TabPanel>
              <TabPanel id="transcript" padding="md">
                <TranscriptTab
                  roomId={roomId}
                  jumpTo={transcriptJump}
                  onJumpDone={() => setTranscriptJump(null)}
                />
              </TabPanel>
            </Tabs>
          </VStack>
        </Center>
      </Screen>
    </UserAware>
  )
}
