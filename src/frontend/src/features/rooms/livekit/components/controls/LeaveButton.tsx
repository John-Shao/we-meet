import { useConnectionState, useRoomContext } from '@livekit/components-react'
import { Button, Menu } from '@/primitives'
import { RiDoorOpenLine, RiPhoneFill, RiShutDownLine } from '@remixicon/react'
import { useTranslation } from 'react-i18next'
import { ConnectionState } from 'livekit-client'
import { Menu as RACMenu, MenuItem } from 'react-aria-components'
import { menuRecipe } from '@/primitives/menuRecipe'
import { useIsAdminOrOwner } from '../../hooks/useIsAdminOrOwner'
import { useEndRoom } from '@/features/rooms/api/endRoom'
import { navigateTo } from '@/navigation/navigateTo'

export const LeaveButton = () => {
  const { t } = useTranslation('rooms', { keyPrefix: 'controls' })
  const room = useRoomContext()
  const connectionState = useConnectionState(room)
  const isAdminOrOwner = useIsAdminOrOwner()
  const { endRoom } = useEndRoom()
  const isDisabled = connectionState === ConnectionState.Disconnected

  const handleLeave = () => {
    room
      .disconnect(true)
      .catch((e) => console.error('An error occurred while disconnecting:', e))
  }

  const handleEndRoom = async () => {
    try {
      await endRoom()
    } catch (e) {
      console.error('An error occurred while ending the room:', e)
    }
    // Navigate first so the onDisconnected callback (which goes to feedback)
    // won't fire — the LiveKitRoom component is unmounted by navigation.
    navigateTo('home')
    room
      .disconnect(true)
      .catch((e) => console.error('An error occurred while disconnecting:', e))
  }

  if (!isAdminOrOwner) {
    return (
      <Button
        isDisabled={isDisabled}
        variant={'danger'}
        tooltip={t('leave')}
        aria-label={t('leave')}
        onPress={handleLeave}
        data-attr="controls-leave"
      >
        <RiPhoneFill
          style={{
            transform: 'rotate(135deg)',
          }}
        />
      </Button>
    )
  }

  return (
    <Menu variant="dark" placement="top">
      <Button
        isDisabled={isDisabled}
        variant={'danger'}
        tooltip={t('leave')}
        aria-label={t('leave')}
        data-attr="controls-leave"
      >
        <RiPhoneFill
          style={{
            transform: 'rotate(135deg)',
          }}
        />
      </Button>
      <RACMenu style={{ minWidth: '180px' }}>
        <MenuItem
          onAction={handleLeave}
          className={menuRecipe({ icon: true, variant: 'dark' }).item}
        >
          <RiDoorOpenLine size={20} />
          {t('leaveRoom')}
        </MenuItem>
        <MenuItem
          onAction={handleEndRoom}
          className={menuRecipe({ icon: true, variant: 'dark' }).item}
        >
          <RiShutDownLine size={20} />
          {t('endRoom')}
        </MenuItem>
      </RACMenu>
    </Menu>
  )
}
