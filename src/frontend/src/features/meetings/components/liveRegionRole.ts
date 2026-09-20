/**
 * 面板回执（`message` 槽）的 live region 角色 —— 一处定义。
 *
 * 这些槽同时承载两类消息：
 *   - 成功回执：`recordAi.accepted`、`humanReview.saved`、`summarySharing.copied`、
 *     `applied` / `undone`、`summaryTasks.created` …
 *   - 失败：限流（`rateLimited`）、权限（`denied` / `requestDenied`）、结果不确定
 *     （`uncertain`）、复制失败（`copyError`）、冲突（`conflict`）…
 *
 * 两类不能共用 `role="status"`：`docs/component-system.md`
 * §「加载、空数据与错误状态」要求**错误**走 `role="alert"` + `aria-live="assertive"`，
 * 否则读屏只会礼貌地念一句就翻过去，用户可能整段错过失败。
 *
 * 这一批面板原先 14 处全写 `role="status"`（其中 11 个文件里 `role="alert"` 为 0），
 * 所以把判断收在这里，调用点只写 `role={receiptRole(message)}`。
 */

/** 明确属于「成功」的词条键。新增成功回执时**必须**在这里补一条。 */
const SUCCESS_MESSAGES = new Set([
  'recordAi.accepted',
  'summarySharing.accepted',
  'summarySharing.copied',
  'summaryExport.accepted',
  'summaryTasks.created',
  'summaryTasks.reused',
  'humanReview.saved',
  'applied',
  'undone',
])

/** 兜底:按命名约定识别的成功后缀(未来新增 `*.accepted` 这类不必再改本文件)。 */
const SUCCESS_SUFFIXES = [
  '.accepted',
  '.saved',
  '.copied',
  '.created',
  '.reused',
]

export const receiptRole = (message: string): 'status' | 'alert' =>
  SUCCESS_MESSAGES.has(message) ||
  SUCCESS_SUFFIXES.some((suffix) => message.endsWith(suffix))
    ? 'status'
    : 'alert'

/**
 * 服务端下发的**任务状态**词条(生成 / 导出 / 投递 / 问答)同一条读数里也可能落在
 * 失败端 —— `summaryExport.status.*` / `summaryNotice.status.*` /
 * `recordQuestion.status.*` 都各自带 `failed / uncertain / unavailable / canceled`。
 * 这些终态必须断言式播报,不能和 `running / ready / delivered` 共用礼貌播报。
 */
const FAILURE_STATUSES = new Set([
  'failed',
  'uncertain',
  'unavailable',
  'canceled',
  'incomplete',
  'denied',
  'conflict',
  'error',
])

export const statusRole = (status: string): 'status' | 'alert' =>
  FAILURE_STATUSES.has(status) ? 'alert' : 'status'
