import {
  RiCalendarLine,
  RiTaskLine,
  RiContactsBookLine,
  RiCheckboxCircleLine,
  RiChatQuoteLine,
} from '@remixicon/react'

export const appCatalog = [
  { id: 'calendar', href: '/calendar', group: 'time', Icon: RiCalendarLine },
  { id: 'tasks', href: '/tasks', group: 'time', Icon: RiTaskLine },
  {
    id: 'contacts',
    href: '/contacts',
    group: 'organization',
    Icon: RiContactsBookLine,
  },
  {
    id: 'approval',
    href: '/approval',
    group: 'organization',
    Icon: RiCheckboxCircleLine,
  },
  {
    id: 'communication',
    href: '/work?view=communication',
    group: 'ai',
    Icon: RiChatQuoteLine,
  },
] as const

export type AppEntry = (typeof appCatalog)[number]
export type AppId = AppEntry['id']
export const availableApps = (workEnabled: boolean) =>
  appCatalog.filter((app) => app.group !== 'ai' || workEnabled)
export const isAppId = (id: unknown): id is AppId =>
  appCatalog.some((app) => app.id === id)
export const isModulePath = (location: string, path: string) =>
  location === path || location.startsWith(`${path}/`)
export function appAtLocation(
  location: string,
  search: string
): AppEntry | undefined {
  const view = new URLSearchParams(search).get('view')
  return appCatalog.find((app) =>
    app.group === 'ai'
      ? location === '/work' &&
        new URLSearchParams(app.href.split('?')[1]).get('view') === view
      : isModulePath(location, app.href)
  )
}
