import { ReactNode, useState } from 'react'
import { css } from '@/styled-system/css'
import { ToggleButton } from 'react-aria-components'
import { HStack, styled, VStack } from '@/styled-system/jsx'
import { RiArrowUpSLine } from '@remixicon/react'
import { useTranslation } from 'react-i18next'

const ToggleHeader = styled(ToggleButton, {
  base: {
    minHeight: 'controlHeight.default',
    paddingRight: 'sm',
    cursor: 'pointer',
    display: 'flex',
    justifyContent: 'space-between',
    width: '100%',
    alignItems: 'center',
    transition: 'background token(durations.slow)',
    borderTopRadius: 'control',
    '&[data-hovered]': {
      backgroundColor: 'surface.canvas',
    },
  },
})

const Container = styled('div', {
  base: {
    border: '1px solid',
    borderColor: 'border.subtle',
    borderRadius: 'control',
    marginX: 'md',
  },
})

const ListContainer = styled(VStack, {
  base: {
    borderTop: '1px solid',
    borderTopColor: 'border.subtle',
    alignItems: 'start',
    overflowX: 'hidden',
    minHeight: 0,
    flexGrow: 1,
    display: 'flex',
    paddingY: 'sm',
    paddingX: 'lg',
    gap: 0,
  },
})

export type ParticipantsCollapsableListProps<T> = {
  heading: string
  participants: Array<T>
  renderParticipant: (participant: T) => JSX.Element
  action?: ReactNode
}

export function ParticipantsCollapsableList<T>({
  heading,
  participants,
  renderParticipant,
  action,
}: ParticipantsCollapsableListProps<T>) {
  const { t } = useTranslation('rooms')
  const [isOpen, setIsOpen] = useState(true)
  const label = t(`participants.collapsable.${isOpen ? 'close' : 'open'}`, {
    name: heading,
  })
  return (
    <Container>
      <ToggleHeader
        isSelected={isOpen}
        aria-label={label}
        onPress={() => setIsOpen(!isOpen)}
        style={{
          borderRadius: !isOpen ? 'var(--radii-control)' : undefined,
        }}
      >
        <HStack
          justify="space-between"
          className={css({
            marginX: 'lg',
            width: '100%',
          })}
        >
          <div
            className={css({
              textStyle: 'bodyLarge',
            })}
          >
            {heading}
          </div>
          <div>{participants?.length || 0}</div>
        </HStack>
        <RiArrowUpSLine
          size={32}
          aria-hidden="true"
          style={{
            transform: isOpen ? 'rotate(-180deg)' : undefined,
            transition: 'transform var(--durations-slow)',
          }}
        />
      </ToggleHeader>
      {isOpen && (
        <ListContainer>
          {action}
          {participants.map((participant) => renderParticipant(participant))}
        </ListContainer>
      )}
    </Container>
  )
}
