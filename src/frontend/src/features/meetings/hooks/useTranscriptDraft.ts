import {
  createContext,
  useContext,
  useState,
  useSyncExternalStore,
} from 'react'

type Draft = {
  editing: boolean
  text: string
  revision: number
  pending: boolean
  failure: 'failed' | 'conflict' | null
}

export function createDraftStore() {
  const drafts = new Map<string, Draft>()
  const listeners = new Set<() => void>()
  let epoch = 0
  const notify = () => listeners.forEach((listener) => listener())
  return {
    get: (id: string) => drafts.get(id),
    epoch: () => epoch,
    set: (id: string, draft: Draft | undefined) => {
      if (draft) drafts.set(id, draft)
      else drafts.delete(id)
      notify()
    },
    clear: () => {
      epoch++
      drafts.clear()
      notify()
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

export const DraftContext = createContext<ReturnType<
  typeof createDraftStore
> | null>(null)

export const useTranscriptDraftScope = () => useContext(DraftContext)

export function useTranscriptDraft(id: string, text: string, revision: number) {
  const shared = useTranscriptDraftScope()
  const [local] = useState(createDraftStore)
  const store = shared ?? local
  const epoch = store.epoch()
  const snapshot = useSyncExternalStore(
    store.subscribe,
    () => store.get(id),
    () => undefined
  )
  const initial: Draft = {
    editing: false,
    text,
    revision,
    pending: false,
    failure: null,
  }
  return {
    state: snapshot ?? initial,
    update: (patch: Partial<Draft>) => {
      if (store.epoch() === epoch)
        store.set(id, { ...(store.get(id) ?? initial), ...patch })
    },
    reset: () => {
      if (store.epoch() === epoch) store.set(id, undefined)
    },
  }
}
