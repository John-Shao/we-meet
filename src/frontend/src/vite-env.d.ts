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
    getStatus(): Promise<DesktopStatus>
    login(): Promise<void>
    logout(): Promise<void>
    retry(): Promise<void>
    onStatus(listener: (status: DesktopStatus) => void): () => void
  }
}
