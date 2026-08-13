import type { ComponentType } from 'react'
import {
  type TitleOptions,
  type ViewProps,
  type ViewStatic,
} from 'react-big-calendar'
import TimeGrid from 'react-big-calendar/lib/TimeGrid'

import type { CalendarEvent } from '../api/ApiCalendar'
import { navigateThreeDay, threeDayRange } from '../utils/threeDayView'

interface ThreeDayEvent {
  id: string
  title: string
  start: Date
  end: Date
  allDay: boolean
  resource: CalendarEvent
}

type ThreeDayViewType = ComponentType<ViewProps<ThreeDayEvent>> &
  ViewStatic & {
    range: (date: Date) => Date[]
  }

const ThreeDayViewBody = (props: ViewProps<ThreeDayEvent>) => (
  <TimeGrid
    {...props}
    range={threeDayRange(new Date(props.date))}
    eventOffset={15}
  />
)

export const ThreeDayView = ThreeDayViewBody as ThreeDayViewType

ThreeDayView.range = threeDayRange
ThreeDayView.navigate = (date, action) => navigateThreeDay(date, action)
ThreeDayView.title = (date: Date, { localizer }: TitleOptions) => {
  const range = threeDayRange(date)
  return localizer.format(
    { start: range[0], end: range[range.length - 1] },
    'dayRangeHeaderFormat'
  )
}
