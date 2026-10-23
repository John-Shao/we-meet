/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_API_BASE_URL: string
  readonly VITE_APP_TITLE: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

interface DesktopStatus {
  version: string
  serviceOrigin: string
  connection: string
  auth: string
  message: string
}
interface Window {
  weMeetDesktop?: {
    isDesktop: true
    platform: string
    remoteControl?: import('../../desktop/src/remote-control/bridge').RemoteControlBridge
    screenPicker?: import('../../desktop/src/screen-picker/bridge').ScreenPickerBridge
    aiCall?: {
      open(): Promise<void>
      getPinned?(): Promise<boolean>
      setPinned?(pinned: boolean): Promise<boolean>
      reportStatus(status: {
        state: 'idle' | 'connecting' | 'active' | 'sharing' | 'error' | 'ended'
        startedAt?: number
        sharing?: boolean
      }): Promise<void>
      onStatus(listener: (status: {
        state: 'idle' | 'connecting' | 'active' | 'sharing' | 'error' | 'ended'
        startedAt?: number
        sharing?: boolean
      }) => void): () => void
    }
    shell?: {
      openMenu(): Promise<void>
      setTheme(theme: 'light' | 'dark'): Promise<void>
      getWindowState(): Promise<{ fullscreen: boolean }>
      onWindowState(
        listener: (state: { fullscreen: boolean }) => void
      ): () => void
    }
    getStatus(): Promise<DesktopStatus>
    login(): Promise<void>
    logout(): Promise<void>
    retry(): Promise<void>
    localWork?: import('./features/work/api/local').LocalWorkBridge
    onStatus(listener: (status: DesktopStatus) => void): () => void
  }
}
