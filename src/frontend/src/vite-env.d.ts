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
    aiCall?: {
      open(): Promise<void>
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
