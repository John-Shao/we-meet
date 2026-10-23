import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import { DesktopStatusBar } from './components/DesktopStatusBar'

const isAiCallFloat = window.location.pathname === '/ai-call-float'
const isSharePicker = window.location.pathname === '/share-picker'

// Supports weights 100-700
import '@fontsource-variable/material-symbols-outlined'

if (window.weMeetDesktop?.shell) {
  document.documentElement.dataset.desktopPlatform =
    window.weMeetDesktop.platform
}
if (isAiCallFloat) {
  document.documentElement.dataset.aiCallFloat = 'true'
}
if (isSharePicker) {
  document.documentElement.dataset.sharePicker = 'true'
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {!isAiCallFloat && !isSharePicker && <DesktopStatusBar />}
    <App />
  </React.StrictMode>
)
