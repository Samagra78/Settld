import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/settld.css'
import AppShell from './app/AppShell'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppShell />
  </StrictMode>,
)
