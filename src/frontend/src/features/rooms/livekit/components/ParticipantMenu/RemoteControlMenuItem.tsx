import { MenuItem, Text } from 'react-aria-components'
import type { Participant } from 'livekit-client'
import { useTranslation } from 'react-i18next'
import { menuRecipe } from '@/primitives/menuRecipe'
import { useRemoteController } from '@/features/remote-control/ControllerContext'
import { css } from '@/styled-system/css'

export function RemoteControlMenuItem({
  participant,
}: {
  participant: Participant
}) {
  const { t } = useTranslation('rooms', {
    keyPrefix: 'remoteControl.controller',
  })
  const controller = useRemoteController()
  const availability = controller.requestAvailability(participant)
  if (availability === 'hidden') return null
  return (
    <MenuItem
      className={menuRecipe().item}
      textValue={t('request')}
      isDisabled={availability !== 'available'}
      onAction={() => controller.request(participant)}
    >
      <Text slot="label">{t('request')}</Text>
      {availability !== 'available' && (
        <Text
          slot="description"
          className={css({
            display: 'block',
            maxWidth: '280px',
            whiteSpace: 'normal',
            fontSize: '0.85em',
          })}
        >
          {t(`unavailable.${availability}`)}
        </Text>
      )}
    </MenuItem>
  )
}
