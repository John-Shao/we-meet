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
  // P4: accepted escalation invite — land straight in the multi-party form.
  const callMeet = !!history.state?.callMeet
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

  // 把「已过预览」写进浏览器级 history.state(独立于 React,组件重挂后仍在),
  // 重挂时 autoJoin 读回 true 直接落房。复用 autoJoin 语义正确:它本就表示
  // 「跳过预览直接进房」。Layout 已按 isLoggedIn(而非 showHeader)分支,进房时
  // 不再重挂 Room,此处属兜底——仅 isLoggedIn 边界翻转等极端情形才用得上。
  const enterRoom = () => {
    try {
      window.history.replaceState(
        { ...window.history.state, autoJoin: true },
        ''
      )
    } catch {
      // history 不可写(极少见)——退化为原行为:可能弹回预览,但不报错。
    }
    setHasSubmittedEntry(true)
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
        <Join enterRoom={enterRoom} roomId={roomId} />
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
        callMeet={callMeet}
      />
    </BaseRoom>
  )
}
