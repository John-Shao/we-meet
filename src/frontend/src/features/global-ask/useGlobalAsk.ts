import { useCallback, useRef, useState } from 'react'

import { ApiError } from '@/api/ApiError'
import { sseStream } from '@/api/sseStream'

/** P1-4 引用形状(§D2):citations 随 meta 先到(灰态),done 带已用编号。 */
export interface GlobalAskCitation {
  n: number
  kind: 'meeting' | 'im' | 'calendar'
  title: string
  snippet?: string
  room_id?: string
  cid?: string
  seq?: number
  date?: string
  event_id?: string
}

export type GlobalAskSources = Record<string, string>

export interface GlobalAskState {
  status: 'idle' | 'asking' | 'done'
  question: string
  answer: string
  citations: GlobalAskCitation[]
  citationsUsed: number[]
  /** LLM 欠费/熔断(§D7):true ⇒ 「检索结果模式」,chips 全可点。 */
  degraded: boolean
  sources: GlobalAskSources
  error: string | null
}

const INITIAL: GlobalAskState = {
  status: 'idle',
  question: '',
  answer: '',
  citations: [],
  citationsUsed: [],
  degraded: false,
  sources: {},
  error: null,
}

/**
 * 全局搜索 AI 问答(单轮,显式触发)。POST `search/ask-stream/`(SSE):
 * meta{citations,sources} → delta×N → done{citations_used, degraded}。
 * 面板关闭必须 abort()(SSE 占用 gunicorn sync worker,§D4)。
 */
export const useGlobalAsk = () => {
  const [state, setState] = useState<GlobalAskState>(INITIAL)
  const abortRef = useRef<AbortController | null>(null)

  const abort = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
  }, [])

  const reset = useCallback(() => {
    abort()
    setState(INITIAL)
  }, [abort])

  const ask = useCallback(
    async (rawQuestion: string) => {
      const question = rawQuestion.trim()
      if (!question) return
      abortRef.current?.abort()
      const ctrl = new AbortController()
      abortRef.current = ctrl
      setState({ ...INITIAL, status: 'asking', question })

      try {
        for await (const ev of sseStream('search/ask-stream/', {
          body: { question },
          signal: ctrl.signal,
        })) {
          if (ev.type === 'meta') {
            const meta = ev as {
              citations?: GlobalAskCitation[]
              sources?: GlobalAskSources
            }
            setState((prev) => ({
              ...prev,
              citations: meta.citations ?? [],
              sources: meta.sources ?? {},
            }))
          } else if (ev.type === 'delta') {
            setState((prev) => ({ ...prev, answer: prev.answer + ev.text }))
          } else if (ev.type === 'error') {
            throw new Error(ev.message)
          } else if (ev.type === 'done') {
            const done = ev as unknown as {
              citations_used?: number[]
              degraded?: boolean
            }
            setState((prev) => ({
              ...prev,
              status: 'done',
              citationsUsed: done.citations_used ?? [],
              degraded: !!done.degraded,
            }))
          }
        }
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return
        const message =
          e instanceof ApiError
            ? `${e.statusCode}`
            : e instanceof Error
              ? e.message
              : String(e)
        setState((prev) => ({ ...prev, status: 'done', error: message }))
      } finally {
        if (abortRef.current === ctrl) abortRef.current = null
        setState((prev) =>
          prev.status === 'asking' ? { ...prev, status: 'done' } : prev
        )
      }
    },
    []
  )

  return { state, ask, abort, reset }
}
