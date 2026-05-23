import { ReactNode, useEffect, useState } from 'react'
import { useLocation, useParams } from 'wouter'
import { ErrorScreen } from '@/components/ErrorScreen'
import { LoadingScreen } from '@/components/LoadingScreen'
import { useUser, UserAware } from '@/features/auth'
import { Conference } from '../components/Conference'
import { Join } from '../components/Join'
import { Permissions } from '../components/Permissions'
import { useKeyboardShortcuts } from '@/features/shortcuts/useKeyboardShortcuts'
import {
  isRoomValid,
  normalizeRoomId,
} from '@/features/rooms/utils/isRoomValid'

const BaseRoom = ({ children }: { children: ReactNode }) => {
  return (
    <UserAware>
      <Permissions />
      {children}
    </UserAware>
  )
}

export const Room = () => {
  const { isLoggedIn } = useUser()
  const [hasSubmittedEntry, setHasSubmittedEntry] = useState(false)

  const { roomId } = useParams()
  const [location, setLocation] = useLocation()
  const initialRoomData = history.state?.initialRoomData
  const mode = isLoggedIn && history.state?.create ? 'create' : 'join'
  const skipJoinScreen = isLoggedIn && mode === 'create'

  useKeyboardShortcuts()

  const clearRouterState = () => {
    if (window?.history?.state) {
      window.history.replaceState({}, '')
    }
  }

  useEffect(() => {
    window.addEventListener('beforeunload', clearRouterState)
    return () => {
      window.removeEventListener('beforeunload', clearRouterState)
    }
  }, [])

  useEffect(() => {
    if (roomId && !isRoomValid(roomId)) {
      setLocation(normalizeRoomId(roomId))
    }
  }, [roomId, setLocation, location])

  // Gate access to the preview/join page behind a login. When useUser
  // resolves to definitively-logged-out, we bounce to the home page with
  // ?next=<slug>; Home picks that up after a successful login and replaces
  // its location with the room URL, putting the user right back into the
  // preview flow they originally followed.
  // isLoggedIn === undefined while loading — don't redirect on that.
  useEffect(() => {
    if (isLoggedIn === false && roomId) {
      setLocation(`/?next=${encodeURIComponent(roomId)}`, { replace: true })
    }
  }, [isLoggedIn, roomId, setLocation])

  if (!roomId) {
    return <ErrorScreen />
  }

  if (!isLoggedIn) {
    // Covers both `undefined` (auth state loading) and `false` (redirect
    // is in flight from the effect above). Showing a loading screen
    // prevents the room preview from briefly flashing during either.
    return <LoadingScreen header={false} footer={false} delay={0} />
  }

  if (!hasSubmittedEntry && !skipJoinScreen) {
    return (
      <BaseRoom>
        <Join enterRoom={() => setHasSubmittedEntry(true)} roomId={roomId} />
      </BaseRoom>
    )
  }

  return (
    <BaseRoom>
      <Conference
        initialRoomData={initialRoomData}
        roomId={roomId}
        mode={mode}
      />
    </BaseRoom>
  )
}
