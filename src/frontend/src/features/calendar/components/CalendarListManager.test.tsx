import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { UnifiedCalendar } from '../api/calendars'
import { CalendarListManager } from './CalendarListManager'

const calendarApi = vi.hoisted(() => ({
  fetchCalendars: vi.fn(),
  setCalendarSubscription: vi.fn(),
  unsubscribeUnifiedCalendar: vi.fn(),
}))

vi.mock('@/api/useConfig', () => ({
  useConfig: () => ({
    data: {
      calendar: {
        enabled: true,
        sharing_enabled: false,
        export_enabled: false,
      },
    },
  }),
}))

vi.mock('../api/calendars', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/calendars')>()),
  ...calendarApi,
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const zh: Record<string, string> = {
        'sidebar.empty': '暂无',
        'sidebar.addCalendar': '+ 添加日历',
        'sidebar.managed': '我管理的',
        'sidebar.subscribed': '我订阅的',
        'sidebar.toggleCalendar': '显示 {{calendar}}',
        'sidebar.calendarColor': '{{calendar}} 颜色',
        'sidebar.calendarMenu': '{{calendar}} 菜单',
        'sidebar.onlyThisCalendar': '仅显示此日历',
        'sidebar.setColor': '设置颜色',
        'sidebar.setCalendarColor': '设置 {{calendar}} 颜色',
        'sidebar.calendarSettings': '日历设置',
        'sidebar.share': '分享',
        'sidebar.export': '导出日历',
        'sidebar.unsubscribe': '取消订阅',
        'detail.close': '关闭',
        'color.pickerTitle': '日历颜色',
        'color.select': '选择 {{color}}',
      }
      let text = zh[key] ?? key
      for (const [optionKey, optionValue] of Object.entries(options ?? {})) {
        text = text.replace(`{{${optionKey}}}`, String(optionValue))
      }
      return text
    },
  }),
}))

const managedCalendar: UnifiedCalendar = {
  id: 'calendar-1',
  kind: 'primary',
  name: 'work',
  display_name: 'Work',
  description: '',
  owner: null,
  meeting_room: null,
  organization_default_access: 'none',
  effective_role: 'admin',
  effective_permission: 'details',
  subscribed: true,
  enabled: true,
  color: '#3370ff',
  subscriber_count: 1,
  capabilities: {
    can_write: true,
    can_manage: true,
    can_share: false,
    can_export: false,
    can_delete: true,
  },
  deleted_at: null,
}

const renderManager = (calendars: UnifiedCalendar[] = [managedCalendar]) => {
  calendarApi.fetchCalendars.mockResolvedValue(calendars)
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <CalendarListManager onChanged={vi.fn()} />
    </QueryClientProvider>
  )
}

describe('CalendarListManager menu', () => {
  it('prefixes a meeting-room calendar with its building name', async () => {
    const roomCalendar: UnifiedCalendar = {
      ...managedCalendar,
      id: 'calendar-room-1203',
      kind: 'resource',
      display_name: '1203',
      meeting_room: {
        id: 'room-1203',
        name: '',
        code: '1203',
        node: { id: 'building-lenovo', name: '联想大厦' },
      },
      capabilities: {
        ...managedCalendar.capabilities,
        can_manage: false,
        can_delete: false,
      },
    }

    renderManager([roomCalendar])

    expect(await screen.findByText('联想大厦-1203')).toBeVisible()
    expect(
      screen.getByRole('checkbox', { name: '显示 联想大厦-1203' })
    ).toBeChecked()
  })

  it('closes on outside click and Escape', async () => {
    renderManager()
    const trigger = await screen.findByRole('button', { name: 'Work 菜单' })

    fireEvent.click(trigger)
    expect(screen.getByRole('menu')).toBeInTheDocument()
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()

    fireEvent.click(trigger)
    expect(screen.getByRole('menu')).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('updates a calendar with one of the App preset colors', async () => {
    calendarApi.setCalendarSubscription.mockResolvedValue(undefined)
    renderManager()

    fireEvent.click(await screen.findByRole('button', { name: 'Work 颜色' }))
    fireEvent.click(await screen.findByRole('radio', { name: '选择 #5ad8a6' }))

    expect(calendarApi.setCalendarSubscription).toHaveBeenCalledWith(
      managedCalendar.id,
      { color: '#5ad8a6' }
    )
  })

  it('lets a subscribed calendar set its display color from the menu', async () => {
    const subscribedCalendar: UnifiedCalendar = {
      ...managedCalendar,
      id: 'calendar-subscribed',
      display_name: 'Ting',
      capabilities: {
        ...managedCalendar.capabilities,
        can_manage: false,
        can_delete: false,
      },
    }
    calendarApi.setCalendarSubscription.mockResolvedValue(undefined)
    renderManager([subscribedCalendar])

    fireEvent.click(await screen.findByRole('button', { name: 'Ting 菜单' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '设置颜色' }))
    expect(screen.getByRole('dialog', { name: '设置 Ting 颜色' })).toBeVisible()
    fireEvent.click(await screen.findByRole('radio', { name: '选择 #5ad8a6' }))

    expect(calendarApi.setCalendarSubscription).toHaveBeenCalledWith(
      subscribedCalendar.id,
      { color: '#5ad8a6' }
    )
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
