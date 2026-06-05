import React from 'react'
import ReactDOM from 'react-dom/client'
import App from '@/App.jsx'
import '@/index.css'
import { initializeErrorReporting } from '@/lib/errorReporting'
import { migrateLegacyAuthTokens } from '@/api/auth'
import { runStorageKeyMigration } from '@/lib/storageKeyMigration'

initializeErrorReporting()
migrateLegacyAuthTokens()

runStorageKeyMigration().finally(() => {
  ReactDOM.createRoot(document.getElementById('root')).render(
    <App />
  )
})
