// Entry of the details page (step 21; the page itself is step 22). A separate HTML entry on purpose: this bundle never
// imports the 3D scene, the clock, the task scheduler or the stores of the home page, so opening or refreshing details
// starts none of them. It reads a snapshot by ID from IndexedDB and nothing else.
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../index.css'
import DetailsApp from './DetailsApp'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DetailsApp />
  </StrictMode>,
)
