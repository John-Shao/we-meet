import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { CALENDAR_COLOR_PALETTE } from '../utils/calendarColors'
import { CalendarColorPicker } from './CalendarColorPicker'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { color?: string }) => {
      if (key === 'color.pickerTitle') return '日历颜色'
      if (key === 'color.select') return `选择 ${options?.color}`
      return key
    },
  }),
}))

describe('CalendarColorPicker', () => {
  it('offers the same 12 payload colors as the App and marks the selection', async () => {
    const onChange = vi.fn()
    render(
      <CalendarColorPicker value="#34C724" label="颜色" onChange={onChange} />
    )

    fireEvent.click(screen.getByRole('button', { name: '颜色' }))

    const options = await screen.findAllByRole('radio')
    expect(options).toHaveLength(12)
    expect(options.map((option) => option.getAttribute('title'))).toEqual([
      ...CALENDAR_COLOR_PALETTE,
    ])
    expect(screen.getByRole('radio', { name: '选择 #34c724' })).toBeChecked()

    fireEvent.click(screen.getByRole('radio', { name: '选择 #9270ca' }))
    expect(onChange).toHaveBeenCalledWith('#9270ca')
    expect(screen.queryByRole('radiogroup', { name: '日历颜色' })).toBeNull()
  })
})
