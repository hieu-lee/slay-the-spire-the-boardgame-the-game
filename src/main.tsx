import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './ui/App.tsx'
import './ui/styles.css'
// The frame around the board. Loaded second so its plain-selector rules win
// ties against the board stylesheet on purpose; see the header of chrome.css.
import './ui/chrome.css'

const container = document.getElementById('root')
if (!container) throw new Error('#root element is missing from index.html')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
