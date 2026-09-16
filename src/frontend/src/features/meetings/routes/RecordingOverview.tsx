import { useTranslation } from 'react-i18next'
import { Link, Redirect, useLocation } from 'wouter'
import { RiMicLine, RiVideoLine } from '@remixicon/react'
import { useConfig } from '@/api/useConfig'
import { useUser } from '@/features/auth'
import { Button } from '@/primitives'
import { PageState } from '@/components/PageState'
import { StateHint } from '@/components/StateHint'
import { css, cx } from '@/styled-system/css'
import { useMeetingRecords } from '../api/fetchMeetingRecord'
import { MeetingModuleShell } from '../components/MeetingModuleShell'
import { MeetingModuleNav } from '../components/MeetingModuleNav'
import { RecordingUpload } from '../components/RecordingUpload'
import {
  entryTile,
  entryTileRow,
  libraryLayout,
  pageHeaderRow,
  pageHeaderText,
  pageTitle,
  rowMeta,
  rowTitle,
  sectionTitle,
} from '../components/libraryStyles'

/** 历史录音最多显示的条数；Android 端 RecordingHomeScreen 用的是同一个数。 */
const HISTORY_LIMIT = 20

/** 区块之间的竖向节奏(与左列导航取同一档)。 */
const section = css({ marginTop: '2xl' })

/** 历史录音整块一张卡:行与行之间用语义分隔线,不再各自画边框。 */
const historyCard = css({
  listStyle: 'none',
  margin: 0,
  padding: 0,
  border: '1px solid token(colors.border.subtle)',
  borderRadius: 'card',
  backgroundColor: 'surface.default',
  overflow: 'hidden',
})

const historyRowCls = css({
  display: 'flex',
  alignItems: 'center',
  gap: 'lg',
  minHeight: 'controlHeight.large',
  padding: 'lg',
  color: 'inherit',
  textDecoration: 'none',
  cursor: 'pointer',
  transition: 'background-color token(durations.fast)',
  _hover: { backgroundColor: 'surface.canvas' },
  _focusVisible: {
    outline: '2px solid token(colors.border.focus)',
    outlineOffset: '-2px',
  },
})

const historyIconCls = css({ flexShrink: 0, color: 'icon.secondary' })

const historyBodyCls = css({ minWidth: 0, overflowWrap: 'anywhere' })

// 来源/状态与时间是两行辅助信息,共用 bodySmall 一档。
const historyMetaCls = cx(rowMeta, css({ display: 'block' }))

const moreLinkCls = css({
  display: 'block',
  textAlign: 'center',
  padding: 'lg',
  textStyle: 'labelLarge',
  color: 'text.link',
  textDecoration: 'none',
  borderRadius: 'field',
  _hover: { textDecoration: 'underline' },
  _focusVisible: {
    outline: '2px solid token(colors.border.focus)',
    outlineOffset: '2px',
  },
})

/** Only history is read here. Capture controls mount at /recording/capture. */
export function RecordingHistory({
  viewerId,
  enabled,
}: {
  viewerId: string
  enabled: boolean
}) {
  const { t, i18n } = useTranslation('meetings')
  const query = useMeetingRecords(viewerId, enabled, {
    scope: 'recent',
    source_type: 'recordings',
    is_ongoing: 'false',
  })
  if (!enabled) return null
  const rows = query.isError ? [] : query.data?.results.slice(0, HISTORY_LIMIT)
  return (
    <section className={section}>
      <h2 className={sectionTitle}>{t('recordingOverview.history')}</h2>
      {query.isError ? (
        <StateHint
          state="error"
          action={
            <Button
              variant="tertiary"
              size="sm"
              onPress={() => void query.refetch()}
            >
              {t('library.refresh')}
            </Button>
          }
        >
          {t('library.loadError')}
        </StateHint>
      ) : !rows ? (
        <StateHint state="loading">{t('loading')}</StateHint>
      ) : rows.length === 0 ? (
        <PageState
          density="compact"
          surface="card"
          icon={<RiMicLine size={20} />}
          description={t('recordingOverview.empty')}
        />
      ) : (
        <ul className={historyCard}>
          {rows.map((record) => (
            <li
              key={record.id}
              className={css({
                '& + &': {
                  borderTop: '1px solid token(colors.border.subtle)',
                },
              })}
            >
              <Link
                href={`/meeting/recording/history/${encodeURIComponent(record.id)}`}
                className={historyRowCls}
              >
                {record.upload?.media_type === 'video' ? (
                  <RiVideoLine
                    size={24}
                    aria-hidden
                    className={historyIconCls}
                  />
                ) : (
                  <RiMicLine size={24} aria-hidden className={historyIconCls} />
                )}
                <span className={historyBodyCls}>
                  <span className={rowTitle}>
                    {record.title || t('library.untitled')}
                  </span>
                  <span className={historyMetaCls}>
                    {t(
                      record.source_type === 'upload'
                        ? `upload.${record.upload?.media_type ?? 'audio'}`
                        : 'library.source.audio_recording'
                    )}
                    {record.upload && (
                      <> · {t(`upload.status.${record.upload.status}`)}</>
                    )}
                  </span>
                  <time dateTime={record.origin_at} className={historyMetaCls}>
                    {new Date(record.origin_at).toLocaleString(i18n.language)}
                  </time>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <Link
        href="/meeting/notes?source_type=recordings"
        className={moreLinkCls}
      >
        {t('video.more')}
      </Link>
    </section>
  )
}

export function RecordingOverview() {
  const [, navigate] = useLocation()
  const { user, isLoggedIn } = useUser()
  const { data, isError } = useConfig()
  const { t } = useTranslation('meetings')
  if (isLoggedIn === false) return <Redirect to="/" />
  if (!user || (!data && !isError))
    return <StateHint state="loading">{t('loading')}</StateHint>
  const enabled = !isError && !!data?.meeting_records?.capture_audio_enabled
  return (
    <MeetingModuleShell compactNavigation>
      <main className={libraryLayout}>
        <div className={css({ md: { display: 'none' } })}>
          <MeetingModuleNav current="/meeting/recording" />
        </div>
        <header className={pageHeaderRow}>
          <div className={pageHeaderText}>
            <h1 className={pageTitle}>{t('library.record')}</h1>
          </div>
        </header>
        {enabled ? (
          <>
            <div className={entryTileRow}>
              <Link href="/meeting/recording/capture" className={entryTile}>
                <RiMicLine size={32} aria-hidden />
                {t('recordingOverview.record')}
              </Link>
              <RecordingUpload
                key={user.id}
                viewerId={user.id}
                tile
                onRecord={(id) => navigate(`/meeting/recording/history/${id}`)}
              />
            </div>
            <RecordingHistory
              key={user.id}
              viewerId={user.id}
              enabled={!!data?.meeting_records?.enabled}
            />
          </>
        ) : (
          <PageState
            density="compact"
            icon={<RiMicLine size={20} />}
            description={t('library.unavailable')}
          />
        )}
      </main>
    </MeetingModuleShell>
  )
}
