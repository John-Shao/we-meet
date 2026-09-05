import { layoutStore } from '@/stores/layout'
import { css } from '@/styled-system/css'
import { Heading } from 'react-aria-components'
import { text } from '@/primitives/Text'
import { IconButton } from '@/primitives'
import { RiArrowLeftLine, RiCloseLine } from '@remixicon/react'
import { useTranslation } from 'react-i18next'
import { ParticipantsList } from './controls/Participants/ParticipantsList'
import { useSidePanel } from '../hooks/useSidePanel'
import { ReactNode } from 'react'
import { Chat } from '../prefabs/Chat'
import { Effects } from './effects/Effects'
import { Admin } from './Admin'
import { Tools } from './Tools'
import { Info } from './Info'
import { RoomAIPanel } from '@/features/room-ai/components/RoomAIPanel'
import { HStack } from '@/styled-system/jsx'
import { useReactionsToolbar } from '@/features/reactions/hooks/useReactionsToolbar'

type StyledSidePanelProps = {
  title: string
  ariaLabel: string
  children: ReactNode
  onClose: () => void
  isClosed: boolean
  closeButtonTooltip: string
  isSubmenu: boolean
  onBack: () => void
  backButtonLabel: string
  isReactionToolbarOpen?: boolean
}

const StyledSidePanel = ({
  title,
  ariaLabel,
  children,
  onClose,
  isClosed,
  isReactionToolbarOpen,
  closeButtonTooltip,
  isSubmenu = false,
  onBack,
  backButtonLabel,
}: StyledSidePanelProps) => (
  <aside
    className={css({
      borderWidth: '1px',
      borderStyle: 'solid',
      borderColor: 'border.default',
      backgroundColor: 'surface.default',
      color: 'text.primary',
      borderRadius: 'panel',
      flex: 1,
      position: 'absolute',
      overflow: 'hidden',
      display: 'flex',
      flexDirection: 'column',
      margin: 'var(--sizes-room-side-panel-margin)',
      marginLeft: 0,
      marginBottom: 0,
      padding: 0,
      gap: 0,
      right: 0,
      top: 0,
      width: 'var(--sizes-room-side-panel)',
      maxWidth: 'calc(100vw - var(--sizes-room-side-panel-margin))',
      transition: '.5s token(easings.standard) 5ms',
    })}
    style={{
      transform: isClosed
        ? 'translateX(calc(var(--sizes-room-side-panel) + var(--sizes-room-side-panel-margin)))'
        : 'none',
      bottom: isReactionToolbarOpen
        ? 'calc( var(--sizes-room-control-bar) + var(--sizes-room-reaction-toolbar-height) + calc(var(--lk-grid-gap) / 2))'
        : 'var(--sizes-room-control-bar)',
    }}
    aria-hidden={isClosed}
    aria-label={ariaLabel}
  >
    <HStack
      alignItems="center"
      className={sidePanelHeaderCls}
      style={{ display: isClosed ? 'none' : undefined }}
    >
      {isSubmenu && (
        <IconButton label={backButtonLabel} size="icon32" onPress={onBack}>
          <RiArrowLeftLine size={20} aria-hidden="true" />
        </IconButton>
      )}
      <Heading
        slot="title"
        level={1}
        className={`${text({ variant: 'h2' })} ${sidePanelTitleCls}`}
      >
        {title}
      </Heading>
      <IconButton label={closeButtonTooltip} size="icon32" onPress={onClose}>
        <RiCloseLine size={20} aria-hidden="true" />
      </IconButton>
    </HStack>
    {children}
  </aside>
)

const sidePanelHeaderCls = css({
  width: 'full',
  flexShrink: 0,
  gap: 'sm',
  paddingX: 'lg',
  paddingY: 'md',
})

const sidePanelTitleCls = css({
  display: 'flex',
  flex: 1,
  minWidth: 0,
  margin: 0,
  paddingTop: '0!',
  justifyContent: 'start',
  alignItems: 'center',
})

type PanelProps = {
  isOpen: boolean
  children: React.ReactNode
  keepAlive?: boolean
}

const Panel = ({ isOpen, keepAlive = false, children }: PanelProps) => (
  <div
    style={{
      display: isOpen ? 'flex' : 'none',
      flexDirection: 'column',
      overflowY: 'auto',
      overflowX: 'hidden',
      flexGrow: 1,
      minHeight: 0,
    }}
  >
    {keepAlive || isOpen ? children : null}
  </div>
)
export const SidePanel = () => {
  const {
    activePanelId,
    isParticipantsOpen,
    isEffectsOpen,
    isChatOpen,
    isSidePanelOpen,
    isToolsOpen,
    isAdminOpen,
    isInfoOpen,
    isRoomAIOpen,
    isSubPanelOpen,
    activeSubPanelId,
  } = useSidePanel()
  const { t } = useTranslation('rooms', { keyPrefix: 'sidePanel' })
  const title = t(`heading.${activeSubPanelId || activePanelId}`)

  const { isOpen: isReactionToolbarOpen } = useReactionsToolbar()

  return (
    <StyledSidePanel
      title={title}
      ariaLabel={t('ariaLabel', { title })}
      onClose={() => {
        layoutStore.activePanelId = null
        layoutStore.activeSubPanelId = null
      }}
      closeButtonTooltip={t('closeButton', {
        content: t(`content.${activeSubPanelId || activePanelId}`),
      })}
      isClosed={!isSidePanelOpen}
      isSubmenu={isSubPanelOpen}
      isReactionToolbarOpen={isReactionToolbarOpen}
      backButtonLabel={t('backToTools')}
      onBack={() => (layoutStore.activeSubPanelId = null)}
    >
      <Panel isOpen={isParticipantsOpen}>
        <ParticipantsList />
      </Panel>
      <Panel isOpen={isEffectsOpen}>
        <Effects />
      </Panel>
      <Panel isOpen={isChatOpen} keepAlive={true}>
        <Chat />
      </Panel>
      <Panel isOpen={isToolsOpen} keepAlive={true}>
        <Tools />
      </Panel>
      <Panel isOpen={isAdminOpen}>
        <Admin />
      </Panel>
      <Panel isOpen={isInfoOpen}>
        <Info />
      </Panel>
      <Panel isOpen={isRoomAIOpen} keepAlive={true}>
        <RoomAIPanel />
      </Panel>
    </StyledSidePanel>
  )
}
