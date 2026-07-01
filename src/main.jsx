// @ts-check
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from '@/App.jsx'
import '@/index.css'
import { initializeErrorReporting } from '@/lib/errorReporting'
import { initializeSystemLogging } from '@/lib/systemLog'
import { migrateLegacyAuthTokens } from '@/api/auth'

initializeSystemLogging()
initializeErrorReporting()
migrateLegacyAuthTokens()

ReactDOM.createRoot(document.getElementById('root')).render(
  <App />
)
