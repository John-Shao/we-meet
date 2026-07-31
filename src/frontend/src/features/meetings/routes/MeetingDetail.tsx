import { ReactNode, useEffect, useMemo, useState } from 'react'

import { useTranslation } from 'react-i18next'
import { useTitle } from 'hoofd'
import ReactMarkdown from 'react-markdown'
import { useParams } from 'wouter'

import { Center, VStack } from '@/styled-system/jsx'
import { css } from '@/styled-system/css'
import { ErrorScreen } from '@/components/ErrorScreen'
import { LoadingScreen } from '@/components/LoadingScreen'
import { Screen } from '@/layout/Screen'
import { Button, H, Text } from '@/primitives'
import { Tabs, Tab, TabList, TabPanel } from '@/primitives/Tabs'
import { UserAware, useUser } from '@/features/auth'

import {
  useMeetingActionItems,
  useMeetingRoom,
  useMeetingSummary,
  useMeetingTranscripts,
  usePatchSummary,
  useRegenerateSummary,
} from '../api/fetchMeeting'

const markdownBodyStyle = css({
  fontSize: '0.95rem',
  lineHeight: '1.7',
  '& > :first-child': { marginTop: 0 },
  '& h1, & h2, & h3, & h4': {
    fontWeight: 600,
    marginTop: '1.25rem',
    marginBottom: '0.5rem',
    lineHeight: '1.3',
  },
  '& h2': { fontSize: '1.35rem' },
  '& h3': { fontSize: '1.15rem' },
  '& h4': { fontSize: '1rem' },
  '& p': { margin: '0.5rem 0' },
  '& ul, & ol': { margin: '0.25rem 0 0.5rem 1.5rem' },
  '& ul': { listStyleType: 'disc' },
  '& ol': { listStyleType: 'decimal' },
  '& code': {
    backgroundColor: 'greyscale.100',
    padding: '0.05rem 0.25rem',
    borderRadius: '3px',
    fontFamily: 'monospace',
    fontSize: '0.92em',
  },
  '& a': { color: 'primary.700', textDecoration: 'underline' },
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

  if (isLoading) return <Text>{t('loading')}</Text>
  // 404 = no summary yet — friendly empty state with regen button.
  if (error?.statusCode === 404)
    return (
      <div
        className={css({
          display: 'flex',
          flexDirection: 'column',
          gap: '0.75rem',
          alignItems: 'flex-start',
        })}
      >
        <Text>{t('summary.empty')}</Text>
        <RegenButton />
      </div>
    )
  if (isError || !data) return <Text>{t('error.loadFailed')}</Text>

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
              fontSize: '0.75rem',
              color: 'greyscale.600',
              backgroundColor: 'greyscale.100',
              borderRadius: '999px',
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
            fontSize: '0.8125rem',
            color: 'greyscale.600',
            backgroundColor: 'greyscale.50',
            border: '1px solid token(colors.greyscale.200)',
            borderRadius: '0.5rem',
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
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={18}
            data-testid="summary-editor"
            className={css({
              width: '100%',
              fontFamily: 'monospace',
              fontSize: '0.875rem',
              lineHeight: 1.6,
              padding: '0.75rem',
              border: '1px solid token(colors.greyscale.300)',
              borderRadius: '0.5rem',
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
        <Text>{t('summary.empty')}</Text>
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
  const { t, i18n } = useTranslation('meetings')
  const { data, isLoading, error } = useMeetingSummary(roomId)

  if (isLoading) return <Text>{t('loading')}</Text>
  if (error?.statusCode === 404) return <Text>{t('chapters.empty')}</Text>
  const chapters = data?.chapters ?? []
  if (chapters.length === 0) return <Text>{t('chapters.empty')}</Text>

  const fmt = (iso: string | null) =>
    iso
      ? new Date(iso).toLocaleTimeString(i18n.language, {
          hour: '2-digit',
          minute: '2-digit',
        })
      : ''

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
          <li
            key={chapter.id}
            onClick={
              jumpable ? () => onJump!(chapter.started_at as string) : undefined
            }
            title={jumpable ? t('chapters.jumpHint') : undefined}
            className={css({
              display: 'flex',
              gap: '0.75rem',
              alignItems: 'flex-start',
              borderRadius: '0.5rem',
              padding: '0.25rem 0.375rem',
              cursor: jumpable ? 'pointer' : 'default',
              _hover: jumpable ? { backgroundColor: 'greyscale.50' } : {},
            })}
          >
            <span
              className={css({
                flexShrink: 0,
                minWidth: '7.5rem',
                fontFamily: 'monospace',
                fontSize: '0.8125rem',
                color: 'greyscale.500',
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
          </li>
        )
      })}
    </ol>
  )
}

const ActionItemsTab = ({ roomId }: { roomId: string }) => {
  const { t } = useTranslation('meetings')
  const { data, isLoading, isError } = useMeetingActionItems(roomId)

  if (isLoading) return <Text>{t('loading')}</Text>
  if (isError) return <Text>{t('error.loadFailed')}</Text>
  if (!data || data.length === 0) return <Text>{t('actionItems.empty')}</Text>

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
            borderColor: 'greyscale.300',
            borderRadius: '6px',
            padding: '0.75rem 1rem',
            backgroundColor: item.is_completed ? 'greyscale.100' : 'greyscale.000',
            opacity: item.is_completed ? 0.7 : 1,
          })}
        >
          <div className={css({ fontWeight: 500, marginBottom: '0.25rem' })}>
            {item.content}
          </div>
          <div
            className={css({
              fontSize: '0.85rem',
              color: 'greyscale.700',
              display: 'flex',
              gap: '1rem',
              flexWrap: 'wrap',
            })}
          >
            {item.owner_text && (
              <span>
                {t('actionItems.owner')}: {item.owner_text}
              </span>
            )}
            {item.due_text && (
              <span>
                {t('actionItems.due')}: {item.due_text}
              </span>
            )}
          </div>
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

  if (isLoading) return <Text>{t('loading')}</Text>
  if (isError) return <Text>{t('error.loadFailed')}</Text>
  if (!data || data.length === 0) return <Text>{t('transcript.empty')}</Text>

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
        const ts = new Date(row.started_at).toLocaleTimeString()
        const speaker = row.speaker_name || row.speaker_identity.slice(0, 12)
        const translationKey = Object.keys(row.translations || {}).find(
          (k) => k.toLowerCase().split('-')[0] === userLang
        )
        const translation = translationKey
          ? row.translations[translationKey]
          : null
        const showTranslation =
          translation &&
          row.language.toLowerCase().split('-')[0] !== userLang
        return (
          <div
            key={row.id}
            id={`transcript-row-${row.id}`}
            className={css({
              borderLeft: '3px solid',
              borderColor: 'greyscale.300',
              paddingLeft: '0.75rem',
              paddingY: '0.25rem',
              transition: 'background-color 0.6s ease',
            })}
            style={
              flashId === row.id
                ? { backgroundColor: 'rgba(59,130,246,0.14)' }
                : undefined
            }
          >
            <div
              className={css({
                fontSize: '0.75rem',
                color: 'greyscale.600',
              })}
            >
              {ts} · {speaker}
            </div>
            <div>{row.text}</div>
            {showTranslation && (
              <div
                className={css({
                  fontStyle: 'italic',
                  color: 'greyscale.700',
                  fontSize: '0.9rem',
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

const InfoRow = ({ label, children }: { label: string; children: ReactNode }) => (
  <div
    className={css({
      display: 'flex',
      gap: '1rem',
      padding: '0.6rem 0',
      borderBottom: '1px solid',
      borderColor: 'greyscale.200',
      alignItems: 'baseline',
    })}
  >
    <div
      className={css({
        width: '5.5rem',
        flexShrink: 0,
        color: 'greyscale.600',
        fontSize: '0.9rem',
      })}
    >
      {label}
    </div>
    <div className={css({ flex: 1, fontSize: '0.95rem', wordBreak: 'break-word' })}>
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

  if (isLoading) return <Text>{t('loading')}</Text>
  if (isError || !data) return <Text>{t('error.loadFailed')}</Text>

  const start = new Date(data.created_at).toLocaleString()
  const end = data.closed_at ? new Date(data.closed_at).toLocaleString() : null
  const timeText = end ? `${start} – ${end}` : `${start}（${t('info.ongoing')}）`

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

export const MeetingDetail = () => {
  const { t } = useTranslation('meetings')
  const { roomId } = useParams<{ roomId: string }>()
  const { isLoggedIn, isLoading: isAuthLoading } = useUser()
  // 拍板 #3 章节→转写跳转:Tabs 受控,章节点击切 Tab 并带上目标时刻。
  const [tabKey, setTabKey] = useState<string>('info')
  const [transcriptJump, setTranscriptJump] = useState<string | null>(null)

  const pageTitle = useMemo(() => `${APP_TITLE} - ${t('pageTitle')}`, [t])
  useTitle(pageTitle)

  if (isLoggedIn === undefined || isAuthLoading) return <LoadingScreen />
  if (!isLoggedIn)
    return (
      <ErrorScreen title={t('auth.title')} body={t('auth.body')} />
    )
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
            <H lvl={1}>{t('pageTitle')}</H>

            <Tabs
              selectedKey={tabKey}
              onSelectionChange={(key) => setTabKey(String(key))}
              className={css({ width: '100%' })}
            >
              <TabList aria-label={t('tabs.label')}>
                <Tab id="info">{t('tabs.info')}</Tab>
                <Tab id="summary">{t('tabs.summary')}</Tab>
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
