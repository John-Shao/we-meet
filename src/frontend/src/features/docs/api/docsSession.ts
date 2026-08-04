import { fetchApi } from '@/api/fetchApi'

type DocsSessionResponse = {
  /** 带一次性票据的 Docs 进站 URL;后端没接上 Docs 时为 null。 */
  url: string | null
}

/**
 * 换一条「带着登录态进云文档」的 URL(内嵌云文档的登录态引导)。
 *
 * 后端拿调用者身份去 Docs 换一张 60 秒、单次使用的票据,拼成
 * `…/api/v1.0/session-from-ticket/?ticket=…&next=…`。iframe 指过去即可拿到 Docs
 * 会话,**全程不经 Keycloak** —— 这正是老路子(`/api/v1.0/authenticate/`)的死穴:
 * 它依赖浏览器里的 KC 会话 cookie,而 meet 的登录态未必留下过这份 cookie;一旦没有,
 * authenticate 就把 iframe 甩到 KC 登录页,再被 KC 的 `frame-ancestors 'self'` 挡死。
 *
 * `next` 是 Docs 站内相对路径(可带 query)。拿不到 URL 时返回 null,调用方退回
 * authenticate 进站 —— 有 KC 会话的浏览器照样能进,没有的由兜底遮罩接手。
 */
export const fetchDocsSessionUrl = (next: string): Promise<string | null> =>
  fetchApi<DocsSessionResponse>('/docs/session/', {
    method: 'POST',
    body: JSON.stringify({ next }),
  })
    .then((data) => data?.url ?? null)
    .catch(() => null)
