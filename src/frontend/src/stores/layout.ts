import { proxy } from 'valtio'
import {
  PanelId,
  SubPanelId,
} from '@/features/rooms/livekit/hooks/useSidePanel'

type State = {
  showHeader: boolean
  appRailCollapsed: boolean
  showFooter: boolean
  showSubtitles: boolean
  activePanelId: PanelId | null
  activeSubPanelId: SubPanelId | null
  showReactionsToolbar: boolean
}

export const layoutStore = proxy<State>({
  showHeader: false,
  appRailCollapsed: false,
  showFooter: false,
  showSubtitles: false,
  activePanelId: null,
  activeSubPanelId: null,
  showReactionsToolbar: false,
})
