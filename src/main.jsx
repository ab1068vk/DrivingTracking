// @ts-check
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from '@/App.jsx'
import '@/index.css'
import { initializeErrorReporting } from '@/lib/errorReporting'
import { initializeSystemLogging } from '@/lib/systemLog'
import { migrateLegacyAuthTokens } from '@/api/auth'
import { initializeNativeAppExperienceWatchdog } from '@/lib/nativeAppExperienceWatchdog'

initializeSystemLogging()
initializeErrorReporting()
initializeNativeAppExperienceWatchdog()
migrateLegacyAuthTokens()

ReactDOM.createRoot(document.getElementById('root')).render(
  <App />
)
