import { Switch, Route } from 'wouter'

import { AdminGuard } from './AdminGuard'
import { AdminShell } from './layout/AdminShell'
import { AdminDashboard } from './pages/Dashboard'
import { AdminOrg } from './pages/Org'
import { AdminMembers } from './pages/Members'
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
        <Route path="/org">
          <AdminOrg />
        </Route>
        <Route path="/members">
          <AdminMembers />
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
