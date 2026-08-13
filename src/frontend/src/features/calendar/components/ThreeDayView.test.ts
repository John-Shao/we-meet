import { Navigate } from 'react-big-calendar'
import { describe, expect, it } from 'vitest'

import { navigateThreeDay, threeDayRange } from '../utils/threeDayView'

describe('ThreeDayView', () => {
  it('renders exactly three consecutive days including weekends', () => {
    const friday = new Date(2026, 7, 14)

    expect(threeDayRange(friday).map((date) => date.getDay())).toEqual([5, 6, 0])
  })

  it('navigates by complete three-day windows', () => {
    const anchor = new Date(2026, 7, 13)

    expect(navigateThreeDay(anchor, Navigate.PREVIOUS)).toEqual(
      new Date(2026, 7, 10)
    )
    expect(navigateThreeDay(anchor, Navigate.NEXT)).toEqual(
      new Date(2026, 7, 16)
    )
  })
})
