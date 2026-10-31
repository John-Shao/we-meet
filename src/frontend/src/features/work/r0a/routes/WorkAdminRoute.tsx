import { RequireAuth } from '@/components/RequireAuth'
import { Screen } from '@/layout/Screen'
import { AdminPage } from './AdminPage'

export const WorkAdminRoute = () => (
  <RequireAuth>
    <Screen footer={false}>
      <AdminPage />
    </Screen>
  </RequireAuth>
)
