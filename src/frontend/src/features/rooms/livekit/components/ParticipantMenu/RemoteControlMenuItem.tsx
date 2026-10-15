import { MenuItem } from 'react-aria-components'
import type { Participant } from 'livekit-client'
import { useTranslation } from 'react-i18next'
import { menuRecipe } from '@/primitives/menuRecipe'
import { useRemoteController } from '@/features/remote-control/ControllerContext'

export function RemoteControlMenuItem({
  participant,
}: {
  participant: Participant
}) {
  const { t } = useTranslation('rooms', {
    keyPrefix: 'remoteControl.controller',
  })
  const controller = useRemoteController()
  if (!controller.canRequest(participant)) return null
  return (
    <MenuItem
      className={menuRecipe().item}
      onAction={() => controller.request(participant)}
    >
      {t('request')}
    </MenuItem>
  )
}
