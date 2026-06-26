import { useCallback, useEffect, useState } from 'react'

// Pinned conversations are a local-only preference for now (frontend v1):
// persisted in localStorage, keyed per IM uid so different accounts on the same
// browser don't share pins. Cross-device sync awaits server-side member
// settings (a future jusi phase).
const keyFor = (uid: string) => `im:pinned:${uid}`

const load = (key: string): Set<string> => {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return new Set()
    const arr: unknown = JSON.parse(raw)
    return Array.isArray(arr)
      ? new Set(arr.filter((x): x is string => typeof x === 'string'))
      : new Set()
  } catch {
    return new Set()
  }
}

const save = (key: string, set: Set<string>) => {
  try {
    localStorage.setItem(key, JSON.stringify([...set]))
  } catch {
    // storage unavailable / quota exceeded — pinning degrades to in-memory.
  }
}

/**
 * Per-user pinned-conversation set, persisted in localStorage. Returns the
 * current set plus a `toggle(cid)`. `uid` resolves after the token query, so
 * the set reloads when it changes.
 */
export const usePinnedConversations = (uid: string) => {
  const key = keyFor(uid)
  const [pinned, setPinned] = useState<Set<string>>(() => load(key))

  useEffect(() => {
    setPinned(load(key))
  }, [key])

  const toggle = useCallback(
    (cid: string) => {
      setPinned((prev) => {
        const next = new Set(prev)
        if (next.has(cid)) next.delete(cid)
        else next.add(cid)
        save(key, next)
        return next
      })
    },
    [key]
  )

  return { pinned, toggle }
}
