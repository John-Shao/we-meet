import { useEffect, useState, type ReactNode } from 'react'
import { DraftContext, createDraftStore } from '../hooks/useTranscriptDraft'

/** Memory only. Mount inside the authenticated record boundary, never globally. */
export function TranscriptDraftScope({ children }: { children: ReactNode }) {
  const [store] = useState(createDraftStore)
  useEffect(() => () => store.clear(), [store])
  return <DraftContext.Provider value={store}>{children}</DraftContext.Provider>
}
