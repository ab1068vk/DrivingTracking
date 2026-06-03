import React from 'react'
import ReactDOM from 'react-dom/client'
import App from '@/App.jsx'
import '@/index.css'
import { initializeErrorReporting } from '@/lib/errorReporting'
import { migrateLegacyAuthTokens } from '@/api/auth'
import { runStorageKeyMigration } from '@/lib/storageKeyMigration'

initializeErrorReporting()
migrateLegacyAuthTokens()

ReactDOM.createRoot(document.getElementById('root')).render(
  <App />
)

runStorageKeyMigration().catch((error) => {
  console.warn('Road Sage storage key migration failed', error)
})
