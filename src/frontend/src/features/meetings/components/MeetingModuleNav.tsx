import { Link } from 'wouter'
import { useTranslation } from 'react-i18next'
import { useConfig } from '@/api/useConfig'
import { css, cx } from '@/styled-system/css'

const row = css({
  display: 'flex',
  flexWrap: 'nowrap',
  gap: 'sm',
  alignItems: 'center',
  marginBottom: 'lg',
  overflowX: 'auto',
})

/**
 * 「会议」二级页那一行导航:会议首页 / 会议实录 / 智能纪要 / AI 录音。
 *
 * 原先写在 `MeetingLibrary` 里,加入会议页(同样是 `/meeting/*` 的二级页)也要
 * 同一行 —— 抽出来是为了这一行只有一份:标签、顺序、`aria-current` 的口径
 * 只要有一处对不上,几个页面并排看就是"导航长得不一样"。
 *
 * 只在窄屏出现(≥md 由左列 `MeetingNavPanel` 常驻),所以是**水平滚动的胶囊**
 * 而不是左列那套竖排行。这里必须是 `<a>`:它换的是 URL,不是同一页的视图模式
 * —— 用 `SegmentedControl` 的 tablist/tab 语义会让读屏把跨页跳转念成页内切换。
 *
 * @param current 当前所在的路径,用来给对应项打 `aria-current="page"`;加入会议
 *   不在这一行里,所以不传。
 */
export const MeetingModuleNav = ({ current }: { current?: string }) => {
  const { t } = useTranslation('meetings')
  const { data } = useConfig()

  const at = (path: string) => (current === path ? 'page' : undefined)
  const item = (path: string) => cx(itemCls, current === path && itemActiveCls)

  return (
    <nav className={row} aria-label={t('library.navigation')}>
      <Link
        href="/meeting"
        aria-current={at('/meeting')}
        className={item('/meeting')}
      >
        {t('library.video')}
      </Link>
      {data?.meeting_records?.capture_audio_enabled && (
        <Link
          href="/meeting/recording"
          aria-current={at('/meeting/recording')}
          className={item('/meeting/recording')}
        >
          {t('library.record')}
        </Link>
      )}
      {data?.meeting_records?.enabled && (
        <>
          <Link
            href="/meeting/notes"
            aria-current={at('/meeting/notes')}
            className={item('/meeting/notes')}
          >
            {t('library.notes')}
          </Link>
          <Link
            href="/meeting/minutes"
            aria-current={at('/meeting/minutes')}
            className={item('/meeting/minutes')}
          >
            {t('library.minutes')}
          </Link>
        </>
      )}
    </nav>
  )
}

// 布局与状态拆成两个 css():cx 叠加同属性原子类按样式表顺序取胜,不是书写顺序
//(见 memory: panda-cx-atomic-order-trap)。选中态用 `action.selected.*`,
// 与桌面左列的 `selected.*` 是同一族语义角色。
const itemCls = css({
  display: 'inline-flex',
  alignItems: 'center',
  flexShrink: 0,
  minHeight: 'controlHeight.compact',
  // 窄屏收到一档内边距:四个入口在 375/390 这类常见机宽下**完整显示**(16px 内边距
  // 时整行比视口宽 2~17px,最后一个胶囊会被切掉一截,只能靠横向滚动去够)。再窄
  // (≤360)仍然横滑,不折行。
  paddingX: { base: 'md', md: 'lg' },
  borderRadius: 'pill',
  textStyle: 'labelMedium',
  textDecoration: 'none',
  whiteSpace: 'nowrap',
  color: 'text.secondary',
  backgroundColor: 'surface.default',
  border: '1px solid token(colors.border.subtle)',
  cursor: 'pointer',
  transition:
    'background-color token(durations.fast), color token(durations.fast), border-color token(durations.fast)',
  _hover: { color: 'text.primary', borderColor: 'border.default' },
  _focusVisible: {
    outline: '2px solid token(colors.border.focus)',
    outlineOffset: '2px',
  },
})

const itemActiveCls = css({
  color: 'action.selected.text',
  backgroundColor: 'action.selected.bg',
  borderColor: 'transparent',
})
