import { readRecovery } from './readRecovery'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ApiError } from '@/api/ApiError'
import { fetchApi } from '@/api/fetchApi'

/** 授权范围:纪要(智能+人工版本)或原文(转写)。 */
export type AccessScope = 'summary' | 'transcript'
export type Person = { id: string; name: string }
export type Grant = Person & {
  active: boolean
  read_summary: boolean
  read_transcript: boolean
}
export type Page<T> = { results: T[]; next_cursor: string | null }
export type Access = Page<Grant> & {
  available: boolean
  can_manage: boolean
  supported_scopes?: string[]
}
export type Selection = {
  user_ids: string[]
  operation: 'grant' | 'revoke'
  access_scope?: AccessScope
}
export type Preview = {
  title: string
  preview_hash: string
  recipients: (Person & {
    after_effective_summary: boolean
    inherited_summary: boolean
    effective_transcript: boolean
    inherited_transcript?: boolean
    after_effective_transcript?: boolean
  })[]
}
type Intent = Selection & { key: string; expected_hash: string }

const uuid = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i

/** 丢失回执后用来核对「同一次操作」的标记;只存请求 ID 与哈希,不含正文。 */
function loadIntent(key: string): Intent | undefined {
  try {
    const value = JSON.parse(
      sessionStorage.getItem(key) ?? 'null'
    ) as Intent | null
    if (
      value &&
      uuid.test(value.key) &&
      /^[a-f0-9]{64}$/.test(value.expected_hash) &&
      ['grant', 'revoke'].includes(value.operation) &&
      (value.access_scope === undefined ||
        ['summary', 'transcript'].includes(value.access_scope)) &&
      Array.isArray(value.user_ids) &&
      value.user_ids.length > 0 &&
      value.user_ids.length <= 50 &&
      value.user_ids.every((id) => uuid.test(id))
    )
      return value
  } catch {
    /* 只有请求 ID 与哈希会被保留,用于结果不明时的核对。 */
  }
}

export const summarySharingPath = (recordId: string) =>
  `meeting-records/${encodeURIComponent(recordId)}/summary-sharing/`

type Config = { recordId: string; viewerId: string; path: string }

/**
 * 纪要授权的写入流程:选人 → 预览(拿到 [Preview.preview_hash])→ 确认。
 *
 * 单独抽成钩子而不是塞进组件,是因为这套流程现在有两个宿主 ——「分享」面板
 * 里的协作管理弹窗负责发起,面板本身还要显示「上次操作结果未确认 + 核对」
 * 和成功/失败回执;状态留在一个宿主里,关掉弹窗那一刻回执就没了。
 *
 * 两个不变量在这里集中守住(都来自后端契约,别在 UI 里重新发明):
 * 1. **没有预览不许写**:`expected_hash` 必须是刚预览出来的那一份;变了就 409。
 * 2. **同一次操作只能有一个 key**:写之前先把意图落进 sessionStorage,响应丢了
 *    也还能用同一个 `Idempotency-Key` 重新核对,而不是制造第二次授权。
 */
export function useSummarySharing({ recordId, viewerId, path }: Config) {
  const { t } = useTranslation('meetings')
  const [selection, setSelection] = useState<Selection>({
    user_ids: [],
    operation: 'grant',
  })
  const [preview, setPreview] = useState<Preview>()
  const storageKey = `meeting-summary-sharing:${viewerId}:${recordId}`
  const [recovery] = useState(() =>
    readRecovery(storageKey, () => loadIntent(storageKey))
  )
  const [intent, setIntent] = useState(recovery.value)
  const [busy, setBusy] = useState(false)
  const [messageKey, setMessageKey] = useState('')
  const inFlight = useRef(false)
  const lifetime = useRef<AbortController | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    lifetime.current = controller
    return () => controller.abort()
  }, [])

  const scope = intent?.access_scope ?? selection.access_scope

  const inspect = async (next: Selection) => {
    if (inFlight.current || !next.user_ids.length) return
    setSelection(next)
    setPreview(undefined)
    const signal = lifetime.current!.signal
    inFlight.current = true
    setBusy(true)
    setMessageKey('')
    try {
      const result = await fetchApi<Preview>(`${path}preview/`, {
        method: 'POST',
        signal,
        body: JSON.stringify(next),
      })
      if (!signal.aborted) {
        setPreview(result)
        return result
      }
    } catch {
      if (!signal.aborted) setMessageKey('summarySharing.previewError')
    } finally {
      inFlight.current = false
      if (!signal.aborted) setBusy(false)
    }
  }

  const submit = async () => {
    if (recovery.blocked) return
    if (inFlight.current || (!intent && !preview)) return
    const request: Intent = intent ?? {
      ...selection,
      key: crypto.randomUUID(),
      expected_hash: preview!.preview_hash,
    }
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(request))
    } catch {
      setMessageKey('summarySharing.storageUnavailable')
      return
    }
    const signal = lifetime.current!.signal
    setIntent(request)
    inFlight.current = true
    setBusy(true)
    setMessageKey('')
    const clear = () => {
      sessionStorage.removeItem(storageKey)
      setIntent(undefined)
      setPreview(undefined)
    }
    try {
      await fetchApi(path, {
        method: 'POST',
        signal,
        headers: { 'Idempotency-Key': request.key },
        meetingCommand: { key: request.key, scope: { record_id: recordId } },
        body: JSON.stringify({
          user_ids: request.user_ids,
          operation: request.operation,
          expected_hash: request.expected_hash,
          access_scope: request.access_scope,
        }),
      })
      if (signal.aborted) return false
      clear()
      setSelection({ user_ids: [], operation: 'grant' })
      setMessageKey('summarySharing.accepted')
      return true
    } catch (error) {
      if (signal.aborted) return false
      if (
        error instanceof ApiError &&
        [400, 409, 422].includes(error.statusCode)
      ) {
        clear()
        setMessageKey(
          error.statusCode === 409
            ? 'summarySharing.conflict'
            : 'summarySharing.loadError'
        )
      } else setMessageKey('summarySharing.uncertain')
      return false
    } finally {
      inFlight.current = false
      if (!signal.aborted) setBusy(false)
    }
  }

  const message = messageKey ? t(messageKey) : ''

  return {
    selection,
    preview,
    scope,
    pending: !!intent,
    pendingCount: intent?.user_ids.length ?? 0,
    busy,
    /** 无可信的回执时禁用一切写操作:未确认的旧操作必须先核对掉。 */
    blocked: recovery.blocked,
    storageUnavailable: recovery.blocked
      ? t('summarySharing.storageUnavailable')
      : '',
    setSelection,
    setPreview,
    inspect,
    submit,
    message,
  }
}

export type SummarySharingWrite = ReturnType<typeof useSummarySharing>
