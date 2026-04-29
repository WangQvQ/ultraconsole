import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { ConsolePage } from './pages/ConsolePage'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ConsolePage />
  </StrictMode>,
)
