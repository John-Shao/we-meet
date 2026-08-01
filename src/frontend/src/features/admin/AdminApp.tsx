import { Switch, Route, Redirect } from 'wouter'

import { useHasPermission } from '@/hooks/useOrgContext'

import { AdminGuard } from './AdminGuard'
import { AdminShell } from './layout/AdminShell'
import { AdminDashboard } from './pages/Dashboard'
import { AdminMembers } from './pages/Members'
import { AdminUserGroups } from './pages/UserGroups'
import { AdminRoles } from './pages/Roles'
import { AdminMeetingRooms } from './pages/MeetingRooms'
import { AdminAudit } from './pages/Audit'

/**
 * Root of the management console (M 端). Mounted under `/admin` via wouter's
 * nested routing, so the paths below are relative to that base
 * (`/` = /admin, `/org` = /admin/org, …). Lazy-loaded from `App.tsx` so its
 * bundle never ships to regular employees.
 */
/**
 * `/admin` 落地页。
 *
 * 不能无条件渲染看板 —— 一个只有 `org.member.read` 的自定义角色进来会看到一个
 * 全是 403 的空看板,那读作产品坏了。没有看板权限就转到他第一个能打开的页面。
 */
const AdminHome = () => {
  const has = useHasPermission()
  if (has('org.stats.read')) return <AdminDashboard />
  const fallback = HOME_FALLBACKS.find(([, permission]) => has(permission))
  if (fallback) return <Redirect to={fallback[0]} replace />
  // 一个权限都没有 —— AdminGuard 早就把这种情况挡在门外了,这里只是兜底。
  return <AdminDashboard />
}

/** 按「最可能是这个人来干什么」排序,不是按导航顺序。 */
const HOME_FALLBACKS: [string, string][] = [
  ['/org', 'org.member.read'],
  ['/groups', 'org.group.read'],
  ['/roles', 'org.role.read'],
  ['/meeting-rooms', 'org.meeting_room.write'],
  ['/audit', 'org.audit.read'],
]

const AdminApp = () => (
  <AdminGuard>
    <AdminShell>
      <Switch>
        <Route path="/">
          <AdminHome />
        </Route>
        {/* 「成员与部门」—— 原 /org(部门树)与 /members(成员表)合并成一页
            四 tab。/members 保留为跳转,只为不打断已有书签。 */}
        <Route path="/org">
          <AdminMembers />
        </Route>
        <Route path="/members">
          <Redirect to="/org" replace />
        </Route>
        <Route path="/groups">
          <AdminUserGroups />
        </Route>
        <Route path="/roles">
          <AdminRoles />
        </Route>
        <Route path="/meeting-rooms">
          <AdminMeetingRooms />
        </Route>
        <Route path="/audit">
          <AdminAudit />
        </Route>
        <Route>
          <AdminHome />
        </Route>
      </Switch>
    </AdminShell>
  </AdminGuard>
)

export default AdminApp
