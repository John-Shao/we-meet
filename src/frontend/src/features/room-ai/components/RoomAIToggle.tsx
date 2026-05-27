import { useTranslation } from 'react-i18next'
import { RiQuestionAnswerLine } from '@remixicon/react'

import { ToggleButton } from '@/primitives'
import { ToggleButtonProps } from '@/primitives/ToggleButton'

import { useSidePanel } from '@/features/rooms/livekit/hooks/useSidePanel'

/**
 * Open the room-AI sidebar.
 *
 * Sibling of ``AIAssistantToggle`` (which dispatches a *participant* AI
 * into the LiveKit room with audio/video). This toggle stays text-only:
 * it just slides the existing SidePanel slot into ``RoomAIPanel``.
 */
export const RoomAIToggle = ({
  onPress,
  ...props
}: Partial<ToggleButtonProps>) => {
  const { t } = useTranslation('room-ai')
  const { isRoomAIOpen, toggleRoomAI } = useSidePanel()
  const tooltipLabel = isRoomAIOpen ? t('toggle.open') : t('toggle.closed')

  return (
    <ToggleButton
      square
      variant="primaryTextDark"
      aria-label={tooltipLabel}
      tooltip={tooltipLabel}
      isSelected={isRoomAIOpen}
      aria-expanded={isRoomAIOpen}
      onPress={(e) => {
        toggleRoomAI()
        onPress?.(e)
      }}
      data-attr={`controls-room-ai-${isRoomAIOpen ? 'open' : 'closed'}`}
      {...props}
    >
      <RiQuestionAnswerLine />
    </ToggleButton>
  )
}
