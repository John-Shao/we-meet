import { fetchApi } from '@/api/fetchApi'

/** 我的文档命中(后端 /docs/my-documents/ 代理,可见性在 Docs 侧过滤)。 */
export interface MyDocumentHit {
  id: string
  title: string
  updated_at: string
  url: string
}

/** 分享云文档到聊天(入口 A):选择器的"我的文档"列表,`q` 为空即最近文档。 */
export const fetchMyDocuments = (q = ''): Promise<MyDocumentHit[]> =>
  fetchApi<{ results: MyDocumentHit[] }>(
    `/docs/my-documents/${q ? `?q=${encodeURIComponent(q)}` : ''}`
  ).then((r) => r.results)
