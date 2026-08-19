import { fetchApi } from '@/api/fetchApi'

/**
 * 分享云文档到聊天:请后端给目标会话成员对该文档授**只读**权限。
 *
 * best-effort:授权是 courtesy(让接收方点开卡片能直接看),失败不提示、不阻断
 * ——退化到"收件人无权限撞 Docs 权限墙",与分享一条裸链接效果一致。后端按 cid
 * 权威解析会话成员(非成员的 cid 会跳过),这里只透传 doc_id + 目标 cids。
 *
 * 返回是否授权成功(失败已内部吞掉,不会 reject),供调用方做后续动作 ——
 * 目前用于「授权成功后通知 docs iframe 刷新成员列表」。不关心结果的调用方
 * 直接 `void grantDocAccess(...)`,语义与原来的 fire-and-forget 一致。
 */
export const grantDocAccess = (
  docId: string,
  cids: string[]
): Promise<boolean> => {
  if (!docId || cids.length === 0) return Promise.resolve(false)
  return fetchApi('/im/grant-doc-access/', {
    method: 'POST',
    body: JSON.stringify({ doc_id: docId, cids }),
  })
    .then(() => true)
    .catch(() => false) // 授权失败静默:不影响卡片已发出、不打扰用户。
}
