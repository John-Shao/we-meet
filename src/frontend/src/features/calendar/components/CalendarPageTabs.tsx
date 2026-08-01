import { useTranslation } from 'react-i18next'

import { css } from '@/styled-system/css'

export const PAGE_TABS = ['calendar', 'meetingRooms'] as const
export type CalendarPageTab = (typeof PAGE_TABS)[number]

/**
 * 「日历 / 会议室」页面级切换 (P9), sitting left of the day/week/month switcher.
 *
 * Underlined rather than pill-shaped on purpose: two pill groups side by side
 * read as one control with eight options, when in fact one picks *what* you are
 * looking at and the other picks *how*.
 */
export const CalendarPageTabs = ({
  tab,
  onTab,
}: {
  tab: CalendarPageTab
  onTab: (next: CalendarPageTab) => void
}) => {
  const { t } = useTranslation('meeting-rooms')
  return (
    <div className={rowCls} role="tablist">
      {PAGE_TABS.map((key) => (
        <button
          key={key}
          type="button"
          role="tab"
          aria-selected={tab === key}
          onClick={() => onTab(key)}
          data-testid={`calendar-page-tab-${key === 'calendar' ? 'calendar' : 'rooms'}`}
          /* Two complete classes, never cx-layered — atomic classes win by
             stylesheet order, not by the order they appear here. */
          className={tab === key ? tabActive : tabIdle}
        >
          {t(`tab.${key}`)}
        </button>
      ))}
    </div>
  )
}

const rowCls = css({
  display: 'flex',
  alignItems: 'center',
  gap: '0.25rem',
})
const tabBase = {
  paddingX: '0.75rem',
  paddingY: '0.4375rem',
  border: 'none',
  borderBottomWidth: '2px',
  borderBottomStyle: 'solid',
  backgroundColor: 'transparent',
  fontSize: '0.9375rem',
  cursor: 'pointer',
  transition: 'color token(durations.normal), border-color token(durations.normal)',
} as const
const tabActive = css({
  ...tabBase,
  borderBottomColor: 'primary.500',
  color: 'primary.600',
  fontWeight: 600,
  // primary.* 固定色阶不随主题翻转,深底上翻到 primaryDark 亮蓝保证可读。
  _dark: { borderBottomColor: 'primaryDark.500', color: 'primaryDark.700' },
})
const tabIdle = css({
  ...tabBase,
  borderBottomColor: 'transparent',
  color: 'greyscale.600',
  _hover: { color: 'greyscale.900' },
})
