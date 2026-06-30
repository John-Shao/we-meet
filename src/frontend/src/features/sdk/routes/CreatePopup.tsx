import { useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { css } from '@/styled-system/css'
import { useCreateRoom } from '../../rooms'
import { useUser } from '@/features/auth'
import { Spinner } from '@/primitives/Spinner'
import { CallbackIdHandler } from '../utils/CallbackIdHandler'
import { PopupWindow } from '../utils/PopupWindow'

const callbackIdHandler = new CallbackIdHandler()
const popupWindow = new PopupWindow()

export const CreatePopup = () => {
  const { t } = useTranslation('home')
  const { isLoggedIn, user } = useUser({
    fetchUserOptions: { attemptSilent: false },
  })
  const { mutateAsync: createRoom } = useCreateRoom()

  const callbackId = useMemo(() => callbackIdHandler.getOrCreate(), [])

  /**
   * Handle unauthenticated users by redirecting to login
   *
   * When redirecting to authentication, the window.location change breaks the connection
   * between this popup and its parent window. We need to send the callbackId to the parent
   * before redirecting so it can re-establish connection after authentication completes.
   * This prevents the popup from becoming orphaned and ensures state consistency.
   */
  useEffect(() => {
    if (isLoggedIn === false) {
      // redirection loses the connection to the manager
      // prevent it passing an async callback id
      popupWindow.sendCallbackId(callbackId, () => {
        popupWindow.navigateToAuthentication()
      })
    }
  }, [isLoggedIn, callbackId])

  /**
   * Automatically create meeting room once user is authenticated
   * This effect will trigger either immediately if the user is already logged in,
   * or after successful authentication and return to this popup
   */
  useEffect(() => {
    const createMeetingRoom = async () => {
      try {
        const owner = (user?.full_name || '').trim()
        const name = owner
          ? t('defaultRoomName', { user: owner })
          : t('defaultRoomNameAnonymous')
        const roomData = await createRoom({
          name,
          callbackId,
        })
        // Send room data back to parent window and clean up resources
        popupWindow.sendRoomData(roomData, () => {
          callbackIdHandler.clear()
          popupWindow.close()
        })
      } catch (error) {
        console.error('Failed to create meeting room:', error)
      }
    }
    if (isLoggedIn && callbackId) {
      createMeetingRoom()
    }
    // Run once when login + callbackId become available; user.full_name / t are
    // read at call time and must NOT re-trigger this (would create duplicate rooms).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoggedIn, callbackId, createRoom])

  return (
    <div
      className={css({
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        height: '100%',
        width: '100%',
      })}
    >
      <Spinner />
    </div>
  )
}
