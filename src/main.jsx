// @ts-check
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from '@/App.jsx'
import '@/index.css'
import { initializeErrorReporting } from '@/lib/errorReporting'
import { initializeSystemLogging } from '@/lib/systemLog'
import { migrateLegacyAuthTokens } from '@/api/auth'
import { initializeNativeAppExperienceWatchdog } from '@/lib/nativeAppExperienceWatchdog'
import { initializeP0Probe } from '@/lib/p0Probe'
import { getBuildIntegrityInfo } from '@/lib/buildIntegrity'

// First, so boot spans and Long Tasks are captured from the earliest point the
// JS runtime can observe them. Inert outside a debug build and in arm D.
initializeP0Probe({ buildHash: getBuildIntegrityInfo().buildHash })

initializeSystemLogging()
initializeErrorReporting()
initializeNativeAppExperienceWatchdog()
migrateLegacyAuthTokens()

ReactDOM.createRoot(document.getElementById('root')).render(
  <App />
)
