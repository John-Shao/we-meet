/** 分享云文档到聊天的线上协议 v1(与 Android / 后端一致)。
 *
 * 与 event-card 不同,这是分享时刻的静态快照——不追更(文档改名/删除后卡片
 * 上的标题/链接维持发送时的样子),所以没有 event-card 那种 kind 多态。
 */
export interface DocCardBody {
  v: number
  doc_id: string
  /** 分享时刻快照,不追更。 */
  title: string
  /** 绝对地址:`${docsBase}/docs/${doc_id}/`。 */
  url: string
  shared_by?: string
}

export const buildDocCardBody = (doc: {
  id: string
  title: string
  url: string
}): string =>
  JSON.stringify({
    v: 1,
    doc_id: doc.id,
    title: doc.title,
    url: doc.url,
  } satisfies DocCardBody)

/** 宽容解析:缺 title → 不可渲染(返回 null,调用方展示灰色占位);缺
 * doc_id/url → 卡片仍渲染但不可点击。 */
export const parseDocCard = (raw: string): DocCardBody | null => {
  try {
    const o = JSON.parse(raw) as Partial<DocCardBody>
    if (!o || typeof o !== 'object' || typeof o.title !== 'string') return null
    return {
      v: typeof o.v === 'number' ? o.v : 1,
      doc_id: typeof o.doc_id === 'string' ? o.doc_id : '',
      title: o.title,
      url: typeof o.url === 'string' ? o.url : '',
      shared_by: typeof o.shared_by === 'string' ? o.shared_by : undefined,
    }
  } catch {
    return null
  }
}
