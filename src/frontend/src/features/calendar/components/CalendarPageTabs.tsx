import { useTranslation } from 'react-i18next'

import { SegmentedControl } from '@/primitives'

// Shared with the route parser; intentionally colocated with the component.
// eslint-disable-next-line react-refresh/only-export-components
export const PAGE_TABS = ['calendar', 'meetingRooms'] as const
export type CalendarPageTab = (typeof PAGE_TABS)[number]

/** Page-level switch between the calendar and meeting-room modes. */
export const CalendarPageTabs = ({
  tab,
  onTab,
}: {
  tab: CalendarPageTab
  onTab: (next: CalendarPageTab) => void
}) => {
  const { t } = useTranslation('meeting-rooms')
  const items = PAGE_TABS.map((key) => ({
    id: key,
    label: t(`tab.${key}`),
    testId: `calendar-page-tab-${key === 'calendar' ? 'calendar' : 'rooms'}`,
  }))

  return (
    <SegmentedControl
      value={tab}
      items={items}
      onChange={onTab}
      ariaLabel={`${t('tab.calendar')} / ${t('tab.meetingRooms')}`}
    />
  )
}
