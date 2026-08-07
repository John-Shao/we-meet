import { ApiError } from '@/api/ApiError'

/**
 * Turn a thrown error into a human-readable message for a console alert.
 *
 * `ApiError.message` is only "Api error <code>"; the useful text (DRF
 * `{detail: …}` or per-field errors like `{reassign: […]}`) lives in `body`.
 * Pull that out so admins see "department has sub-departments; …" rather than
 * "Api error 400".
 */
export const describeApiError = (e: unknown): string => {
  if (e instanceof ApiError) {
    const body = e.body
    if (body && typeof body === 'object') {
      const obj = body as Record<string, unknown>
      const val = obj.detail ?? Object.values(obj)[0]
      if (Array.isArray(val) && val.length) return String(val[0])
      if (typeof val === 'string') return val
    }
    return e.message
  }
  return e instanceof Error ? e.message : String(e)
}

/**
 * 后端额外带的**机器可读分类**,给需要中文文案的那几条校验用。
 *
 * `describeApiError` 交出来的是 DRF 的原文,而后端的 `.po` 里几乎没有中文 ——
 * 管理台其余部分全是中文,只有这几句校验是英文。所以拒绝理由确定的那几条会多带
 * 一个 `code`(+ 用于插值的字段),前端按 code 映射;认不出的 code 退回原文,
 * 不至于变成一句空话。先例:群机器人回调地址被拒时的 `outbound_http` category。
 *
 * ⚠️ **同一个后端会吐出两种形状**,这里两种都得认:
 *
 * - `{"code": "scheme"}` —— 在 **viewset 方法**里抛的 `ValidationError`,
 *   DRF 原样交出去(群机器人回调地址那条)
 * - `{"code": ["unscopable_scope"]}` —— 在 **serializer 的 `validate()`** 里
 *   抛的,DRF 的 `as_serializer_error` 会把每个值规整成列表(角色那两条)
 *
 * 只认字符串的话,serializer 那一路永远拿不到 code、永远退回英文原文 —— 而且
 * **前端什么都不会报**,只是文案不对。这是后端单测抓到的,不是真机。
 *
 * 返回 `null` 表示这个错误没带 code,调用方直接用 `describeApiError`。
 */
export const apiErrorCode = (
  e: unknown,
): { code: string; params: Record<string, unknown> } | null => {
  if (!(e instanceof ApiError) || !e.body || typeof e.body !== 'object') {
    return null
  }
  const { code, ...rest } = e.body as Record<string, unknown>
  const flat = Array.isArray(code) ? code[0] : code
  if (typeof flat !== 'string' || !flat) return null
  // 列表插值成 "org.bot.read, org.audit.read" —— i18n 那边只认字符串。
  const params: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(rest)) {
    params[key] = Array.isArray(value) ? value.join(', ') : value
  }
  return { code: flat, params }
}

type Translate = (key: string, options?: Record<string, unknown>) => string

/**
 * 角色页三个入口（改权限 / 授予 / 新建）共用的报错文案。
 *
 * 结构化接 `t` 而不是在 `errors.ts` 里建 hook：这是个 api 模块，而三个调用点
 * 本来就各自持有 `t` 和 `showAlert`。
 */
export const describeRoleError = (t: Translate, e: unknown): string => {
  const fallback = describeApiError(e)
  const hit = apiErrorCode(e)
  if (!hit) return fallback
  return t(`roles.error.${hit.code}`, {
    ...hit.params,
    defaultValue: fallback,
  })
}
