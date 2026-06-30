import { app, BrowserWindow, shell } from 'electron'
import path from 'node:path'

// Dev: load the running frontend Vite dev server (src/frontend `npm run dev`,
// port 3000 — see src/frontend/vite.config.ts). Prod: load the packaged
// renderer (frontend `dist`, copied to dist/renderer by scripts/copy-renderer.mjs).
const DEV_RENDERER_URL = process.env.WEMEET_RENDERER_URL ?? 'http://localhost:3000'

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    title: 'We-Meet',
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // Security baseline: isolate the renderer, no Node in the web context.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  if (app.isPackaged) {
    void win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  } else {
    void win.loadURL(DEV_RENDERER_URL)
  }

  // External links (target=_blank / window.open) open in the system browser,
  // never a bare Electron window. OIDC will later route through here too.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
}

void app.whenReady().then(() => {
  createWindow()

  // macOS: re-create a window when the dock icon is clicked and none are open.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS (standard platform behavior).
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
