import { Switch, Route, Redirect } from 'wouter'

import { AdminGuard } from './AdminGuard'
import { AdminShell } from './layout/AdminShell'
import { AdminDashboard } from './pages/Dashboard'
import { AdminMembers } from './pages/Members'
import { AdminMeetingRooms } from './pages/MeetingRooms'
import { AdminAudit } from './pages/Audit'

/**
 * Root of the management console (M 端). Mounted under `/admin` via wouter's
 * nested routing, so the paths below are relative to that base
 * (`/` = /admin, `/org` = /admin/org, …). Lazy-loaded from `App.tsx` so its
 * bundle never ships to regular employees.
 */
const AdminApp = () => (
  <AdminGuard>
    <AdminShell>
      <Switch>
        <Route path="/">
          <AdminDashboard />
        </Route>
        {/* 「成员与部门」—— 原 /org(部门树)与 /members(成员表)合并成一页
            四 tab。/members 保留为跳转,只为不打断已有书签。 */}
        <Route path="/org">
          <AdminMembers />
        </Route>
        <Route path="/members">
          <Redirect to="/org" replace />
        </Route>
        <Route path="/meeting-rooms">
          <AdminMeetingRooms />
        </Route>
        <Route path="/audit">
          <AdminAudit />
        </Route>
        <Route>
          <AdminDashboard />
        </Route>
      </Switch>
    </AdminShell>
  </AdminGuard>
)

export default AdminApp
