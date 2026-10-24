import {
  RiCalendarLine,
  RiTaskLine,
  RiContactsBookLine,
  RiCheckboxCircleLine,
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
] as const

export type AppEntry = (typeof appCatalog)[number]
export type AppId = AppEntry['id']
export const isAppId = (id: unknown): id is AppId =>
  appCatalog.some((app) => app.id === id)
export const isModulePath = (location: string, path: string) =>
  location === path || location.startsWith(`${path}/`)
export function appAtLocation(location: string): AppEntry | undefined {
  return appCatalog.find((app) => isModulePath(location, app.href))
}
