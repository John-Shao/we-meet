import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { isAppId, type AppId } from './catalog'

type Preferences = { favorites: AppId[]; recent: AppId[] }
const defaults: Preferences = {
  favorites: ['calendar', 'tasks', 'approval'],
  recent: [],
}
const defaultSnapshot = JSON.stringify(defaults)
const eventName = 'we-meet:app-preferences'
const memory = new Map<string, string>()
const keyFor = (owner: string) => `we-meet:apps:v1:${encodeURIComponent(owner)}`
const ids = (value: unknown): AppId[] =>
  Array.isArray(value) ? [...new Set(value.filter(isAppId))] : []
function parse(raw: string): Preferences {
  try {
    const value = JSON.parse(raw)
    if (!value || !Array.isArray(value.favorites)) return defaults
    return {
      favorites: ids(value.favorites),
      recent: ids(value.recent).slice(0, 10),
    }
  } catch {
    return defaults
  }
}
function snapshot(key: string) {
  if (memory.has(key)) return memory.get(key)!
  try {
    return localStorage.getItem(key) ?? defaultSnapshot
  } catch {
    return memory.get(key) ?? defaultSnapshot
  }
}

export function useAppPreferences(owner: string) {
  const key = keyFor(owner)
  const subscribe = useCallback(
    (notify: () => void) => {
      const onStorage = (event: StorageEvent) => {
        if (event.key === key || event.key === null) {
          memory.delete(key)
          notify()
        }
      }
      const onChange = (event: Event) => {
        if ((event as CustomEvent<string>).detail === key) notify()
      }
      window.addEventListener('storage', onStorage)
      window.addEventListener(eventName, onChange)
      return () => {
        window.removeEventListener('storage', onStorage)
        window.removeEventListener(eventName, onChange)
      }
    },
    [key]
  )
  const raw = useSyncExternalStore(
    subscribe,
    useCallback(() => snapshot(key), [key]),
    () => defaultSnapshot
  )
  const preferences = useMemo(() => parse(raw), [raw])
  const update = useCallback(
    (change: (previous: Preferences) => Preferences) => {
      if (!owner) return
      const next = JSON.stringify(change(parse(snapshot(key))))
      if (next === snapshot(key)) return
      try {
        localStorage.setItem(key, next)
        memory.delete(key)
      } catch {
        memory.set(key, next)
      }
      window.dispatchEvent(new CustomEvent(eventName, { detail: key }))
    },
    [key, owner]
  )
  const add = useCallback(
    (id: AppId) =>
      update((p) => ({ ...p, favorites: [...new Set([...p.favorites, id])] })),
    [update]
  )
  const remove = useCallback(
    (id: AppId) =>
      update((p) => ({
        ...p,
        favorites: p.favorites.filter((item) => item !== id),
      })),
    [update]
  )
  const move = useCallback(
    (id: AppId, target: AppId) =>
      update((p) => {
        const from = p.favorites.indexOf(id),
          to = p.favorites.indexOf(target)
        if (from < 0 || to < 0 || from === to) return p
        const favorites = [...p.favorites]
        favorites.splice(to, 0, favorites.splice(from, 1)[0])
        return { ...p, favorites }
      }),
    [update]
  )
  const opened = useCallback(
    (id: AppId) =>
      update((p) => ({
        ...p,
        recent: [id, ...p.recent.filter((item) => item !== id)].slice(0, 10),
      })),
    [update]
  )
  return { ...preferences, add, remove, move, opened }
}
