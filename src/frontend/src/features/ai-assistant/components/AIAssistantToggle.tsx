import { Dialog, DialogTrigger, Popover } from 'react-aria-components'
import { RiRobot2Line } from '@remixicon/react'
import { useTranslation } from 'react-i18next'

import { ToggleButton } from '@/primitives'
import { ToggleButtonProps } from '@/primitives/ToggleButton'
import { css } from '@/styled-system/css'

import { useAIAssistant } from '../hooks/useAIAssistant'
import { AIAssistantPanel } from './AIAssistantPanel'

export const AIAssistantToggle = ({
  variant = 'primaryTextDark',
  onPress,
  ...props
}: ToggleButtonProps) => {
  const { t } = useTranslation('ai-assistant')
  const { isActive, canControl } = useAIAssistant()

  if (!canControl) return null

  const tooltipLabel = isActive ? t('toggle.active') : t('toggle.inactive')

  return (
    <DialogTrigger>
      <ToggleButton
        square
        variant={variant}
        aria-label={tooltipLabel}
        tooltip={tooltipLabel}
        isSelected={isActive}
        onPress={onPress}
        data-attr="toggle-ai-assistant"
        {...props}
      >
        <RiRobot2Line />
      </ToggleButton>
      <Popover>
        <Dialog
          aria-label={t('panel.title')}
          className={css({ outline: 'none' })}
        >
          <AIAssistantPanel />
        </Dialog>
      </Popover>
    </DialogTrigger>
  )
}
