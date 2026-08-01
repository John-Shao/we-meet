import { useQuery } from '@tanstack/react-query'

import { fetchApi } from '@/api/fetchApi'

/**
 * The caller's own membership context: which organization they are in, their
 * role, and whether they administer it.
 *
 * Backend source: src/backend/core/api/directory.py → GET /directory/me/
 */
export interface OrgContext {
  organization: { id: string; name: string } | null
  org_role: string | null
  /**
   * 组织自己的 owner/administrator。**保留原义**——M2 加了细粒度权限之后它仍然
   * 只表「全权管理员」,老客户端不受影响。判断某个具体能力请读 `permissions`。
   */
  is_org_admin: boolean
  /**
   * 调用者持有的管理权限点(P10 M2)。owner/administrator 是全集;其余人是其
   * `AdminRole` 授权的并集。M 端导航按它过滤——只有 HR 角色的人看不到
   * 「角色与权限」。老后端不返回该字段,`undefined` 按空处理。
   */
  permissions?: string[]
  /**
   * 管理范围。`departments` 时只能管这些部门**及其子树**;`all` 不受限。
   * 注意「按部门授权但 department_ids 为空」在服务端就被拒了,不会出现。
   */
  admin_scope?: { type: 'all' | 'departments'; department_ids: string[] }
}

export const fetchOrgContext = (): Promise<OrgContext> =>
  fetchApi<OrgContext>('/directory/me/')

/**
 * Lives outside `features/admin` on purpose.
 *
 * The C 端 Header needs `is_org_admin` to decide whether to offer the console
 * link, and importing the admin module's hook to get it would pull the whole
 * console into the main bundle — defeating the `lazy(() => import(
 * '@/features/admin'))` split in App.tsx. It was never admin-only data anyway.
 *
 * Shared React Query key, so the Header and the console's guard resolve one
 * request between them.
 */
export const useOrgContext = () =>
  useQuery({
    queryKey: ['org', 'me'],
    queryFn: fetchOrgContext,
    staleTime: 5 * 60_000,
  })

/**
 * 判定当前用户是否持有某个权限点。
 *
 * 未加载完成时一律返回 false —— 宁可短暂地少显示一个入口,也不要先渲染出来再
 * 消失(那既晃眼又会让人点到一个马上会 403 的页面)。
 */
export const useHasPermission = () => {
  const { data } = useOrgContext()
  const granted = data?.permissions
  return (permission: string): boolean =>
    Array.isArray(granted) ? granted.includes(permission) : false
}
