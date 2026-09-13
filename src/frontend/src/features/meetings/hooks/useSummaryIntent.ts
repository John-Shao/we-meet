import { useCallback, useEffect, useRef, useState } from 'react'

import type { SummaryRequestPayload } from '../api/ApiMeetingRecord'

export type SummaryIntent<T> = { key: string; payload: T }
export type AutomationPayload = { enabled: boolean; expected_revision: number }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const integer = (value: unknown, minimum: number) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum

export const isSummaryPayload = (
  value: unknown
): value is SummaryRequestPayload =>
  object(value) &&
  Object.keys(value).every((key) =>
    [
      'operation',
      'stage',
      'expected_revision',
      'expected_job_id',
      'expected_attempt',
    ].includes(key)
  ) &&
  ['generate', 'regenerate', 'retry'].includes(String(value.operation)) &&
  (value.stage === undefined ||
    ['realtime', 'quick', 'final'].includes(String(value.stage))) &&
  integer(value.expected_revision, 1) &&
  (value.expected_job_id === null ||
    (typeof value.expected_job_id === 'string' &&
      value.expected_job_id.length > 0 &&
      value.expected_job_id.length <= 128)) &&
  (value.expected_attempt === null || integer(value.expected_attempt, 1)) &&
  (value.expected_job_id === null) === (value.expected_attempt === null)

export const isAutomationPayload = (
  value: unknown
): value is AutomationPayload =>
  object(value) &&
  Object.keys(value).every((key) =>
    ['enabled', 'expected_revision'].includes(key)
  ) &&
  typeof value.enabled === 'boolean' &&
  integer(value.expected_revision, 0)

/** Tab-scoped recovery only: no transcript, auto-dispatch, expiry or cross-account lookup. */
export function useSummaryIntent<T>(
  kind: 'summary' | 'automation' | 'online-capture' | 'capture-translation',
  viewer: string,
  record: string,
  validate: (value: unknown) => value is T
) {
  const storageKey = `meeting-summary-intent:v1:${JSON.stringify([kind, viewer, record])}`
  const alive = useRef(false)
  const [state, setState] = useState<{
    scope: string
    pending?: SummaryIntent<T>
    ready: boolean
    checked: boolean
  }>({ scope: storageKey, ready: false, checked: false })
  const update = (pending: SummaryIntent<T> | undefined, ready: boolean) => {
    if (alive.current)
      setState((previous) =>
        previous.scope === storageKey
          ? { scope: storageKey, pending, ready, checked: true }
          : previous
      )
  }
  const read = useCallback((): SummaryIntent<T> | undefined => {
    const raw = sessionStorage.getItem(storageKey)
    if (raw === null) return undefined
    if (raw.length > 16384) throw new Error('invalid_summary_intent')
    const value: unknown = JSON.parse(raw)
    if (
      !object(value) ||
      Object.keys(value).some((key) => !['key', 'payload'].includes(key)) ||
      typeof value.key !== 'string' ||
      !uuid.test(value.key) ||
      !validate(value.payload)
    )
      throw new Error('invalid_summary_intent')
    return value as SummaryIntent<T>
  }, [storageKey, validate])
  const reload = () => {
    try {
      update(read(), true)
    } catch {
      update(state.pending, false)
    }
  }
  useEffect(() => {
    alive.current = true
    try {
      setState({
        scope: storageKey,
        pending: read(),
        ready: true,
        checked: true,
      })
    } catch {
      setState({ scope: storageKey, ready: false, checked: true })
    }
    return () => {
      alive.current = false
    }
  }, [storageKey, read])
  const getOrCreate = (payload: T): SummaryIntent<T> => {
    try {
      if (
        !alive.current ||
        state.scope !== storageKey ||
        !state.ready ||
        !validate(payload)
      )
        throw new Error('summary_intent_not_ready')
      const intent = read() ?? { key: crypto.randomUUID(), payload }
      sessionStorage.setItem(storageKey, JSON.stringify(intent))
      update(intent, true)
      return intent
    } catch (error) {
      update(state.pending, false)
      throw error
    }
  }
  const resolve = (expected: SummaryIntent<T>) => {
    try {
      const current = read()
      if (
        current &&
        (current.key !== expected.key ||
          JSON.stringify(current.payload) !== JSON.stringify(expected.payload))
      ) {
        update(current, true)
        return false
      }
      sessionStorage.removeItem(storageKey)
      update(undefined, true)
      return true
    } catch {
      update(expected, false)
      return false
    }
  }
  return {
    pending: state.scope === storageKey ? state.pending : undefined,
    ready: state.scope === storageKey && state.ready,
    failed: state.scope === storageKey && state.checked && !state.ready,
    getOrCreate,
    resolve,
    reload,
  }
}
