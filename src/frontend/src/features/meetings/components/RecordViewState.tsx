import { useRef, type ReactNode } from 'react'
import { ViewState } from '../hooks/useRecordViewState'

/** Ephemeral UI preferences only. Queries and protected content still unmount. */
export function RecordViewState({ children }: { children: ReactNode }) {
  const values = useRef(new Map<string, unknown>())
  return (
    <ViewState.Provider value={values.current}>{children}</ViewState.Provider>
  )
}
