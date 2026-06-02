import { ReactNode, useMemo } from 'react'

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
    backgroundColor: 'gray.100',
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
  const { data, isLoading, isError, error } = useMeetingSummary(roomId)
  const regen = useRegenerateSummary(roomId)

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

  return (
    <div
      className={css({
        display: 'flex',
        flexDirection: 'column',
        gap: '0.75rem',
      })}
    >
      <div className={css({ alignSelf: 'flex-end' })}>
        <RegenButton />
      </div>
      {/* failed / empty / 404 all read the same to a meeting participant:
          "no summary to show". The regenerate button stays available. */}
      {data.status === 'failed' || !data.content ? (
        <Text>{t('summary.empty')}</Text>
      ) : (
        <div className={markdownBodyStyle}>
          <ReactMarkdown>{data.content}</ReactMarkdown>
        </div>
      )}
    </div>
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
            borderColor: 'gray.300',
            borderRadius: '6px',
            padding: '0.75rem 1rem',
            backgroundColor: item.is_completed ? 'gray.100' : 'white',
            opacity: item.is_completed ? 0.7 : 1,
          })}
        >
          <div className={css({ fontWeight: 500, marginBottom: '0.25rem' })}>
            {item.content}
          </div>
          <div
            className={css({
              fontSize: '0.85rem',
              color: 'gray.700',
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

const TranscriptTab = ({ roomId }: { roomId: string }) => {
  const { t, i18n } = useTranslation('meetings')
  const { data, isLoading, isError } = useMeetingTranscripts(roomId)

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
            className={css({
              borderLeft: '3px solid',
              borderColor: 'gray.300',
              paddingLeft: '0.75rem',
              paddingY: '0.25rem',
            })}
          >
            <div
              className={css({
                fontSize: '0.75rem',
                color: 'gray.600',
              })}
            >
              {ts} · {speaker}
            </div>
            <div>{row.text}</div>
            {showTranslation && (
              <div
                className={css({
                  fontStyle: 'italic',
                  color: 'gray.700',
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
      borderColor: 'gray.200',
      alignItems: 'baseline',
    })}
  >
    <div
      className={css({
        width: '5.5rem',
        flexShrink: 0,
        color: 'gray.600',
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
              defaultSelectedKey="info"
              className={css({ width: '100%' })}
            >
              <TabList aria-label={t('tabs.label')}>
                <Tab id="info">{t('tabs.info')}</Tab>
                <Tab id="summary">{t('tabs.summary')}</Tab>
                <Tab id="action-items">{t('tabs.actionItems')}</Tab>
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
              <TabPanel id="transcript" padding="md">
                <TranscriptTab roomId={roomId} />
              </TabPanel>
            </Tabs>
          </VStack>
        </Center>
      </Screen>
    </UserAware>
  )
}
