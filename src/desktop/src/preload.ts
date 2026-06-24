import { contextBridge } from 'electron'

// Minimal, safe surface exposed to the renderer via contextBridge. The web app
// can feature-detect desktop via `window.weMeetDesktop?.isDesktop`. This grows
// as desktop features land (native notifications, tray, deep links, screen
// share picker, auto-update status…), but never exposes raw Node/ipc directly.
contextBridge.exposeInMainWorld('weMeetDesktop', {
  isDesktop: true,
  platform: process.platform,
})
