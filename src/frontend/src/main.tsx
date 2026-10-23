import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import { DesktopStatusBar } from './components/DesktopStatusBar'

const isAiCallFloat = window.location.pathname === '/ai-call-float'

// Supports weights 100-700
import '@fontsource-variable/material-symbols-outlined'

if (window.weMeetDesktop?.shell) {
  document.documentElement.dataset.desktopPlatform =
    window.weMeetDesktop.platform
}
if (isAiCallFloat) {
  document.documentElement.dataset.aiCallFloat = 'true'
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {!isAiCallFloat && <DesktopStatusBar />}
    <App />
  </React.StrictMode>
)
