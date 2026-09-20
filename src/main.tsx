import { WelcomeScreen } from './ui/WelcomeScreen.tsx'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './ui/App.tsx'
import './ui/styles.css'
// The frame around the board. Loaded second so its plain-selector rules win
// ties against the board stylesheet on purpose; see the header of chrome.css.
import './ui/chrome.css'
import './ui/styles/welcome.css'

const container = document.getElementById('root')
if (!container) throw new Error('#root element is missing from index.html')

const query = new URLSearchParams(location.search)
if (query.has('run-vod') || query.has('run-vod-export')) {
  document.querySelectorAll('link[rel="preload"][as="image"]').forEach(link => link.remove())
}
if (query.has('run-vod-export')) {
  void import('./ui/run-vod.ts').then(({ runVodExportWorker }) => runVodExportWorker())
} else {
  createRoot(container).render(
    <StrictMode>
      <WelcomeScreen><App /></WelcomeScreen>
    </StrictMode>,
  )
}
