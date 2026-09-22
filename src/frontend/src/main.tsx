import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import { DesktopStatusBar } from './components/DesktopStatusBar'

// Supports weights 100-700
import '@fontsource-variable/material-symbols-outlined'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <DesktopStatusBar />
    <App />
  </React.StrictMode>
)
