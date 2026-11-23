import { useEffect, useState } from 'react'
import { shipmentIntegrityConfigured, verifyShipmentIntegrity } from './shipmentIntegrity.js'

/** A concise read-only indicator; never claims a shipment was anchored unless verified. */
export default function ShipmentIntegrityTag({ batchId, shipment }) {
  const [status, setStatus] = useState('checking')
  useEffect(() => {
    let active = true
    setStatus('checking')
    if (shipmentIntegrityConfigured && batchId && shipment?.shipmentId) {
      verifyShipmentIntegrity(batchId, shipment).then(result => {
        if (active) setStatus(result.status)
      })
    }
    return () => { active = false }
  }, [batchId, shipment])
  if (!shipmentIntegrityConfigured || !shipment?.shipmentId) return null
  const display = {
    checking: 'Checking record…',
    verified: '✓ Integrity verified',
    modified: '⚠ Record differs from original',
    'not-anchored': 'Not blockchain-verified',
    unavailable: 'Verification unavailable',
    unconfigured: ''
  }
  return <small className={`shipment-integrity shipment-integrity--${status}`} role="status">{display[status] || ''}</small>
}
