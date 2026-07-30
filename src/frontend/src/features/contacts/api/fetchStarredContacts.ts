import { fetchApi } from '@/api/fetchApi'

import type { DirectoryMember } from './ApiDirectory'

/**
 * GET /api/v1.0/directory/starred/ — 我的星标联系人(裸数组,不分页:一份个人
 * 星标名单本来就短)。返回的是标准成员卡片,所以列表渲染与通讯录完全共用。
 *
 * 已离开组织的人自然不在结果里 —— 后端按对方在本组织的 Membership 投影。
 */
export const fetchStarredContacts = (): Promise<DirectoryMember[]> =>
  fetchApi<DirectoryMember[]>('/directory/starred/')
