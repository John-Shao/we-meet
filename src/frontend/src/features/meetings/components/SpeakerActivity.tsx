import { useTranslation } from 'react-i18next'
import type { ApiMeetingSpeaker } from '../api/ApiCaptureSession'
import { css } from '@/styled-system/css'
import { SpeakerTimeline } from './SpeakerTimeline'

export function SpeakerActivity({
  activity,
  onSeek,
}: Pick<ApiMeetingSpeaker, 'activity'> & { onSeek?: (ms: number) => void }) {
  const { t } = useTranslation('meetings')
  const valid =
    activity?.basis === 'recognized_speaker_time' &&
    ['available', 'partial'].includes(activity.status) &&
    typeof activity.duration_ms === 'number' &&
    Number.isFinite(activity.duration_ms) &&
    activity.duration_ms >= 0 &&
    typeof activity.share_percent === 'number' &&
    Number.isFinite(activity.share_percent) &&
    activity.share_percent >= 0 &&
    activity.share_percent <= 100
  if (!valid) return <p>{t('speakerActivity.unavailable')}</p>
  const duration = activity.duration_ms!
  const share = activity.share_percent!
  return (
    <div>
      <p>
        {t('speakerActivity.value', {
          time: `${Math.floor(duration / 60000)}:${String(Math.floor(duration / 1000) % 60).padStart(2, '0')}`,
          percent: share,
        })}
      </p>
      <meter
        min={0}
        max={100}
        value={share}
        aria-label={t('speakerActivity.share')}
        className={css({ width: '100%' })}
      />
      {activity.status === 'partial' && <p>{t('speakerActivity.partial')}</p>}
      <SpeakerTimeline timeline={activity.timeline} onSeek={onSeek} />
    </div>
  )
}
