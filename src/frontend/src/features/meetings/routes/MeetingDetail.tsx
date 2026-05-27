import { useMemo } from 'react'

import { useTranslation } from 'react-i18next'
import { useTitle } from 'hoofd'
import { useParams } from 'wouter'

import { Center, VStack } from '@/styled-system/jsx'
import { css } from '@/styled-system/css'
import { ErrorScreen } from '@/components/ErrorScreen'
import { LoadingScreen } from '@/components/LoadingScreen'
import { Screen } from '@/layout/Screen'
import { H, Text } from '@/primitives'
import { Tabs, Tab, TabList, TabPanel } from '@/primitives/Tabs'
import { UserAware, useUser } from '@/features/auth'

import {
  useMeetingActionItems,
  useMeetingSummary,
  useMeetingTranscripts,
} from '../api/fetchMeeting'

const APP_TITLE = import.meta.env.VITE_APP_TITLE ?? ''

// ---------------------------------------------------------------------------
// Tab bodies
// ---------------------------------------------------------------------------

const SummaryTab = ({ roomId }: { roomId: string }) => {
  const { t } = useTranslation('meetings')
  const { data, isLoading, isError, error } = useMeetingSummary(roomId)

  if (isLoading) return <Text>{t('loading')}</Text>
  // 404 = no summary yet — friendly empty state, not an error.
  if (error?.statusCode === 404)
    return <Text>{t('summary.empty')}</Text>
  if (isError || !data)
    return <Text>{t('error.loadFailed')}</Text>

  if (data.status === 'failed')
    return (
      <Text>
        {t('summary.failed')}
        {data.error_message ? `: ${data.error_message}` : ''}
      </Text>
    )

  return (
    <pre
      className={css({
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        fontFamily: 'inherit',
        fontSize: '0.95rem',
        lineHeight: '1.6',
        margin: 0,
      })}
    >
      {data.content || t('summary.empty')}
    </pre>
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
              defaultSelectedKey="summary"
              className={css({ width: '100%' })}
            >
              <TabList aria-label={t('tabs.label')}>
                <Tab id="summary">{t('tabs.summary')}</Tab>
                <Tab id="action-items">{t('tabs.actionItems')}</Tab>
                <Tab id="transcript">{t('tabs.transcript')}</Tab>
              </TabList>
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
