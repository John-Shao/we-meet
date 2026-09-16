import { useTranslation } from 'react-i18next'
import { Link, Redirect, useParams } from 'wouter'
import { useConfig } from '@/api/useConfig'
import { useUser } from '@/features/auth'
import { Button } from '@/primitives'
import { StateHint } from '@/components/StateHint'
import { css, cx } from '@/styled-system/css'
import { useMeetingRecord } from '../api/fetchMeetingRecord'
import { MeetingModuleShell } from '../components/MeetingModuleShell'
import { UploadedRecordingStatus } from '../components/RecordingUpload'
import {
  libraryLayout,
  pageLead,
  pageTitle,
  rowMeta,
  sectionTitle,
} from '../components/libraryStyles'

/** 详情内容:标题 + 元信息 + 两份资料入口。 */
const detailStack = css({
  display: 'flex',
  flexDirection: 'column',
  gap: 'lg',
})

/** 详情标题允许长标题换行,其余同页面主标题一档。 */
const detailTitle = css({ overflowWrap: 'anywhere' })

/** 详情页页头:返回链接与标题之间的间距。 */
const detailPageTitle = cx(pageTitle, css({ marginTop: 'lg' }))

/** 资料入口卡(实录 / 纪要各一张)。 */
const materialCard = css({
  padding: 'lg',
  border: '1px solid token(colors.border.subtle)',
  borderRadius: 'card',
  backgroundColor: 'surface.default',
})

const materialHintCls = cx(rowMeta, css({ marginY: 'md' }))

const materialLinkCls = css({
  textStyle: 'labelLarge',
  color: 'text.link',
  borderRadius: 'field',
  _hover: { textDecoration: 'underline' },
  _focusVisible: {
    outline: '2px solid token(colors.border.focus)',
    outlineOffset: '2px',
  },
})

const backLinkCls = css({
  textStyle: 'labelLarge',
  color: 'text.link',
  borderRadius: 'field',
  _hover: { textDecoration: 'underline' },
  _focusVisible: {
    outline: '2px solid token(colors.border.focus)',
    outlineOffset: '2px',
  },
})

export function RecordingDetailContent({
  viewerId,
  recordId,
}: {
  viewerId: string
  recordId: string
}) {
  const { t, i18n } = useTranslation('meetings')
  const query = useMeetingRecord(viewerId, recordId, true)
  const record =
    !query.isError &&
    query.data &&
    ['audio_recording', 'upload'].includes(query.data.source_type)
      ? query.data
      : undefined
  if (query.isError || (query.data && !record))
    return (
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
    )
  if (!record) return <StateHint state="loading">{t('loading')}</StateHint>
  return (
    <div className={detailStack}>
      <h2 className={cx(pageTitle, detailTitle)}>
        {record.title || t('library.untitled')}
      </h2>
      <p className={pageLead}>
        {t(
          record.source_type === 'upload'
            ? `upload.${record.upload?.media_type ?? 'audio'}`
            : 'library.source.audio_recording'
        )}{' '}
        ·{' '}
        <time dateTime={record.origin_at}>
          {new Date(record.origin_at).toLocaleString(i18n.language)}
        </time>
      </p>
      {record.upload && (
        <p className={pageLead}>
          {record.upload.name} ·{' '}
          {(record.upload.size / 1024 / 1024).toLocaleString(i18n.language, {
            maximumFractionDigits: 2,
          })}{' '}
          MB · {t(`upload.status.${record.upload.status}`)}
        </p>
      )}
      {record.source_type === 'upload' && record.upload?.can_control && (
        <UploadedRecordingStatus viewerId={viewerId} recordId={recordId} />
      )}
      {record.source_type !== 'upload' &&
        record.retention_mode !== 'unknown' && (
          <p className={pageLead}>
            {t(
              `recordingOverview.${record.retention_mode === 'text' ? 'textOnly' : 'keepAudio'}`
            )}
          </p>
        )}
      {(['notes', 'minutes'] as const).map((kind) => {
        const allowed =
          kind === 'notes'
            ? record.capabilities.read_transcript
            : record.capabilities.read_summary
        return (
          <section key={kind} className={materialCard}>
            <h3 className={sectionTitle}>{t(`library.${kind}`)}</h3>
            <p className={materialHintCls}>
              {t(
                !allowed
                  ? 'video.materialUnavailable'
                  : kind === 'notes'
                    ? 'video.recordHint'
                    : record.has_summary
                      ? 'video.summaryReady'
                      : 'video.summaryPending'
              )}
            </p>
            {allowed && (
              <Link
                href={`/meeting/records/${encodeURIComponent(record.id)}${kind === 'minutes' ? '?tab=summary' : ''}`}
                className={materialLinkCls}
              >
                {t(
                  kind === 'notes' ? 'video.viewRecord' : 'detail.viewSummary'
                )}
              </Link>
            )}
          </section>
        )
      })}
    </div>
  )
}

export function RecordingDetail() {
  const { recordId } = useParams<{ recordId: string }>()
  const { user, isLoggedIn } = useUser()
  const { data, isError } = useConfig()
  const { t } = useTranslation('meetings')
  if (isLoggedIn === false) return <Redirect to="/" />
  if (!user || (!data && !isError))
    return <StateHint state="loading">{t('loading')}</StateHint>
  return (
    <MeetingModuleShell compactNavigation>
      <main className={libraryLayout}>
        <Link href="/meeting/recording" className={backLinkCls}>
          {t('recordingOverview.back')}
        </Link>
        <h1 className={detailPageTitle}>{t('recordingOverview.detail')}</h1>
        {!isError && data?.meeting_records?.enabled && recordId ? (
          <RecordingDetailContent
            key={`${user.id}:${recordId}`}
            viewerId={user.id}
            recordId={recordId}
          />
        ) : (
          <StateHint state="empty">{t('library.unavailable')}</StateHint>
        )}
      </main>
    </MeetingModuleShell>
  )
}
