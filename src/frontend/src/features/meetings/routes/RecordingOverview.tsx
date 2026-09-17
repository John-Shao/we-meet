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
  contentSurface,
  headerActions,
  listStack,
  pageFixedTop,
  pageHeaderRow,
  pageHeaderText,
  pageShell,
  pageTitle,
  rowBody,
  rowHeadingOneLine,
  rowIconTile,
  rowMetaRow,
  rowSurface,
  scrollRegion,
  sectionHeading,
} from '../components/libraryStyles'

/** 历史录音最多显示的条数；Android 端 RecordingHomeScreen 用的是同一个数。 */
const HISTORY_LIMIT = 20

/** 页壳(铺满内容列,不限宽居中)。 */
const canvasShell = pageShell('canvas')

/** 列表区:唯一的滚动区,内容铺白(一级页规则,与另外三个栏目页同一档)。 */
const listRegion = cx(scrollRegion, contentSurface, css({ paddingTop: 'xs' }))

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
    <section>
      <h2 className={sectionHeading}>{t('recordingOverview.history')}</h2>
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
        <ul className={listStack}>
          {rows.map((record) => (
            <li key={record.id}>
              <Link
                href={`/meeting/recording/history/${encodeURIComponent(record.id)}`}
                className={rowSurface}
              >
                {/* 行风格与实录/纪要同一套:48px 品牌浅蓝底图标块 + 标题 + 辅助信息。 */}
                <span aria-hidden className={rowIconTile}>
                  {record.upload?.media_type === 'video' ? (
                    <RiVideoLine size={24} />
                  ) : (
                    <RiMicLine size={24} />
                  )}
                </span>
                <span className={rowBody}>
                  {/* 长标题(上传文件的原始名可能很长)被省略时,悬停可看全。 */}
                  <span className={rowHeadingOneLine} title={record.title}>
                    {record.title || t('library.untitled')}
                  </span>
                  {/* 与「会议实录」同一套读数:时间 · 来源(· 上传状态),单行排列 ——
                      同一条记录在两个栏目里不该是两种版式。 */}
                  <span className={rowMetaRow}>
                    <time dateTime={record.origin_at}>
                      {new Date(record.origin_at).toLocaleString(i18n.language)}
                    </time>
                    <span aria-hidden>·</span>
                    <span>
                      {t(
                        record.source_type === 'upload'
                          ? `upload.${record.upload?.media_type ?? 'audio'}`
                          : 'library.source.audio_recording'
                      )}
                      {record.upload &&
                        ` · ${t(`upload.status.${record.upload.status}`)}`}
                    </span>
                  </span>
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
      <main className={canvasShell}>
        {/* 入口块 + 页头是这一页的「工具区」:固定住,滚到底也还能点开始录音。 */}
        <div className={pageFixedTop}>
          <div className={css({ md: { display: 'none' } })}>
            <MeetingModuleNav current="/meeting/recording" />
          </div>
          <header className={pageHeaderRow}>
            {/* 页头只有标题:四个一级页都不再带副标题(2026-09-17)。 */}
            <div className={pageHeaderText}>
              <h1 className={pageTitle}>{t('library.record')}</h1>
            </div>
            {/* 页头动作与其它栏目页同一档:headerActions 里放 action 尺寸 + 18px 图标的
                按钮,右对齐。这一页是「录制/导入」两个动作的归属页,会议实录页只查/看。
                **录音在前、导入在后**(与 App 端 RecordingHomeScreen 同序:录音卡片在左),
                主操作走 primary —— 与视频会议页的「快速会议」是同一档实心按钮。 */}
            {enabled && (
              <div className={headerActions}>
                <Button
                  variant="primary"
                  size="action"
                  icon={<RiMicLine size={18} aria-hidden />}
                  onPress={() => navigate('/meeting/recording/capture')}
                >
                  {t('library.startRecording')}
                </Button>
                <RecordingUpload
                  key={user.id}
                  viewerId={user.id}
                  onRecord={(id) =>
                    navigate(`/meeting/recording/history/${id}`)
                  }
                />
              </div>
            )}
          </header>
        </div>
        <div className={listRegion} data-testid="meeting-list-region">
          {enabled ? (
            <RecordingHistory
              key={user.id}
              viewerId={user.id}
              enabled={!!data?.meeting_records?.enabled}
            />
          ) : (
            <PageState
              density="compact"
              icon={<RiMicLine size={20} />}
              description={t('library.unavailable')}
            />
          )}
        </div>
      </main>
    </MeetingModuleShell>
  )
}
