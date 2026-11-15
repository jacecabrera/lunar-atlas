import { useState } from 'react'
import { applyConfirmedReset } from '../state/confirmedReset'

// Clear / Reset input (step 23): the confirmed dialog is the only way to unlock a time axis locked by an accepted
// calculation, and to erase the mission inputs, results, custom sites and routes together. Cancelling does nothing;
// detail-page snapshots are separate and are never touched. Confirming returns the clock to the system now with
// autoplay at the default speed.

export default function ClearReset() {
  const [asking, setAsking] = useState(false)
  const confirm = () => { setAsking(false); applyConfirmedReset() }
  return (
    <>
      <button className="hud-btn" onClick={() => setAsking(true)} title="Erase the mission inputs, results, custom sites and routes; unlock the time axis and return to now">Clear</button>
      {asking && (
        <div role="dialog" aria-modal="true" aria-label="Clear mission inputs and results" className="dialog-overlay">
          <div className="dialog-box">
            <div>Clear the mission inputs, results, custom sites and routes, and reset the advanced settings?</div>
            <div className="hint" style={{ marginTop: 6 }}>The time axis is unlocked and returns to the current time, running at the default speed. Saved detail pages are not affected.</div>
            <div className="dialog-row">
              <button className="btn-primary" onClick={confirm}>Clear</button>
              <button className="hud-btn" onClick={() => setAsking(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
