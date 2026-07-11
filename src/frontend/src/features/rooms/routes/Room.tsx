import { ReactNode, useEffect, useState } from 'react'
import { useLocation, useParams } from 'wouter'
import { ErrorScreen } from '@/components/ErrorScreen'
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
  // P1 一对一通话: the caller/callee already committed by calling/answering,
  // so `autoJoin` skips the Join preview and lands straight in the room.
  // `callAudioOnly` keeps the camera off for 语音通话 without touching the
  // user's persisted device preferences.
  const autoJoin = !!history.state?.autoJoin
  const callAudioOnly = !!history.state?.callAudioOnly
  // Peer identity carried by the call controller for the minimal in-call UI
  // (voice). Lost on refresh (clearRouterState) — acceptable: a refreshed call
  // is a dropped call, and the UI just falls back to the full meeting view.
  const callPeer = history.state?.callPeer as
    | { uid: string; name: string; avatar?: string }
    | undefined
  const [hasSubmittedEntry, setHasSubmittedEntry] = useState(autoJoin)

  const { roomId } = useParams()
  const [location, setLocation] = useLocation()
  const initialRoomData = history.state?.initialRoomData
  // `create` 仅用于让 Conference 进房后自动弹邀请框;不再据此跳过预览。
  // 快速会议 / 创建会议 也先过「加入会议」预览页(挑麦克风/摄像头)再进房。
  const mode = isLoggedIn && history.state?.create ? 'create' : 'join'

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

  if (!roomId) {
    return <ErrorScreen />
  }

  if (!hasSubmittedEntry) {
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
        audioOnly={callAudioOnly}
        callPeer={callPeer}
      />
    </BaseRoom>
  )
}
