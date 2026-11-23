import { useEffect, useState } from 'react'
import { loadProcessing, PROCESSING_ADDRESS, processingConfigured } from './processingConfig.js'

function when(seconds) {
  return new Date(seconds * 1000).toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' })
}

export default function ProcessingStatus({ batchId, compact = false }) {
  const [record, setRecord] = useState(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    setRecord(null);setError('')
    if (!batchId || !processingConfigured) return
    loadProcessing(batchId).then(data => { if (active) setRecord(data) }).catch(e => { if (active) setError(e.message) })
    return () => { active = false }
  }, [batchId])
  if (!processingConfigured) return null
  return <section className="result-card processing-on-chain-status">
    <div className="result-head"><div><span className="step-tag">PROCESSING</span><h2>Processing facility</h2></div></div>
    {error ? <p role="status">Processing record unavailable: {error}</p> : !record ? <p>Checking the Processing contract…</p> : !record.exists ? <p>No processing event has been recorded for this batch.</p> : <>
      <p><strong>Processing completed</strong> ✓</p>
      <div className="detail-list">
        <div><span>Quantity received</span><strong>{record.quantityKg} kg</strong></div>
        <div><span>Processing method</span><strong>{record.method}</strong></div>
        <div><span>Processing date</span><strong>{when(record.date)}</strong></div>
        <div><span>Confirmed in block</span><strong>#{record.block}</strong></div>
      </div>
      {!compact && <a className="external-link" target="_blank" rel="noreferrer" href={`https://sepolia.etherscan.io/address/${PROCESSING_ADDRESS}`}>View transaction details ↗</a>}
    </>}
  </section>
}
