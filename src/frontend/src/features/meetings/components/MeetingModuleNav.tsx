import { Link } from 'wouter'
import { useTranslation } from 'react-i18next'
import { useConfig } from '@/api/useConfig'
import { css } from '@/styled-system/css'

const row = css({
  display: 'flex',
  flexWrap: 'wrap',
  gap: '0.75rem',
  alignItems: 'center',
  marginBottom: '1rem',
})

/**
 * 「会议」二级页那一行导航:会议首页 / 会议实录 / 智能纪要 / AI 录音。
 *
 * 原先写在 `MeetingLibrary` 里,加入会议页(同样是 `/meeting/*` 的二级页)也要
 * 同一行 —— 抽出来是为了这一行只有一份:标签、顺序、`aria-current` 的口径
 * 只要有一处对不上,几个页面并排看就是"导航长得不一样"。
 *
 * @param current 当前所在的路径,用来给对应项打 `aria-current="page"`;加入会议
 *   不在这一行里,所以不传。
 */
export const MeetingModuleNav = ({ current }: { current?: string }) => {
  const { t } = useTranslation('meetings')
  const { data } = useConfig()

  const at = (path: string) => (current === path ? 'page' : undefined)

  return (
    <nav className={row} aria-label={t('library.navigation')}>
      <Link href="/meeting" aria-current={at('/meeting')}>
        {t('library.video')}
      </Link>
      {data?.meeting_records?.capture_audio_enabled && (
        <Link href="/meeting/recording" aria-current={at('/meeting/recording')}>
          {t('library.record')}
        </Link>
      )}
      {data?.meeting_records?.enabled && (
        <>
          <Link href="/meeting/notes" aria-current={at('/meeting/notes')}>
            {t('library.notes')}
          </Link>
          <Link href="/meeting/minutes" aria-current={at('/meeting/minutes')}>
            {t('library.minutes')}
          </Link>
        </>
      )}
    </nav>
  )
}
