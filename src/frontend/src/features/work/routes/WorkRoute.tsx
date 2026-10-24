import { useSearchParams } from 'wouter'
import { useUser } from '@/features/auth'
import { RequireAuth } from '@/components/RequireAuth'
import { Screen } from '@/layout/Screen'
import './work.css'
import { AgentWork } from './AgentWork'
import { LocalWorkspaceWork } from './LocalWorkspaceWork'
import { WorkModulePage, WorkNavigation } from './WorkNavigation'

export const WorkRoute = () => {
  const { user } = useUser()
  const [params] = useSearchParams()
  const view = params.get('view') || 'new'
  return (
    <RequireAuth>
      <Screen footer={false}>
        <WorkNavigation active={view}>
          {view === 'new' ? (
            window.weMeetDesktop?.localWork &&
            params.get('execution') !== 'cloud' ? (
              <LocalWorkspaceWork
                key={`${user?.id}-${view}`}
                ownerId={user?.id || ''}
                view={view}
              />
            ) : (
              <AgentWork
                key={`${user?.id}-${view}`}
                ownerId={user?.id || ''}
                view={view}
              />
            )
          ) : (
            <WorkModulePage />
          )}
        </WorkNavigation>
      </Screen>
    </RequireAuth>
  )
}
