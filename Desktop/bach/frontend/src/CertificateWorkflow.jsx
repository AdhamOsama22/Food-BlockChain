import { useState } from 'react'
import { BrowserProvider } from 'ethers'
import { saveSignedMetadata } from './BatchMetadata'
import { CHAIN_ID } from './sepoliaConfig'

const API = (import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:3001').replace(/\/$/, '')

/** Farmer provides only the actual PDF; certifier supplies certification details. */
export async function submitFarmerCertificate(batchId, file) {
  if (!file || file.size > 10 * 1024 * 1024 || !file.name.toLowerCase().endsWith('.pdf')) {
    throw new Error('Select a certificate PDF up to 10 MB.')
  }
  const bytes = await file.arrayBuffer()
  const header = new TextDecoder().decode(bytes.slice(0, 5))
  if (header !== '%PDF-') throw new Error('Invalid PDF document.')
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const hash = '0x' + [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, '0')).join('')
  const data = new FormData()
  data.append('file', file)
  const response = await fetch(`${API}/upload`, { method: 'POST', body: data })
  const uploaded = await response.json()
  if (!response.ok) throw new Error(uploaded.error || 'Certificate PDF upload failed.')
  await saveSignedMetadata(batchId, 'certSubmission', { cid: uploaded.cid, hash })
}

function ReviewItem({ item, contract, onApproved, busy, setBusy }) {
  const [number, setNumber] = useState('')
  const [issueDate, setIssueDate] = useState('')
  const [expiryDate, setExpiryDate] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  async function approve(e) {
    e.preventDefault()
    setBusy(true); setError(''); setMessage('')
    try {
      if (!number.trim() || number.trim().length > 100) throw new Error('Enter a certificate number (up to 100 characters).')
      if (!issueDate || !expiryDate) throw new Error('Enter issue and expiry dates.')
      const issue = Math.floor(Date.parse(`${issueDate}T00:00:00Z`) / 1000)
      const expiry = Math.floor(Date.parse(`${expiryDate}T00:00:00Z`) / 1000)
      if (!Number.isFinite(issue) || !Number.isFinite(expiry) || issue <= 0 || issue > Math.floor(Date.now() / 1000) || expiry <= Math.floor(Date.now() / 1000) || expiry <= issue) {
        throw new Error('Issue date must not be in the future and expiry must be later than today and the issue date.')
      }
      const batch = await contract.batches(BigInt(item.batchId))
      if (!batch.exists || batch.farmer.toLowerCase() !== item.farmer.toLowerCase()) throw new Error('Batch does not match the submitted farmer.')
      const tx = await contract.registerCertificate(BigInt(item.batchId), number.trim(), item.cid, item.hash, BigInt(issue), BigInt(expiry))
      const receipt = await tx.wait()
      if (receipt.status !== 1) throw new Error('Transaction failed.')
      setMessage('Certificate successfully registered.')
      onApproved(item.batchId)
    } catch (err) { setError(err.shortMessage || err.message) } finally { setBusy(false) }
  }
  return <article className="cert-review-item">
    <div className="result-head"><div><span className="step-tag">AWAITING REVIEW</span><h3>Batch #{item.batchId}</h3></div><span className="status-chip">Pending</span></div>
    <a href={`https://gateway.pinata.cloud/ipfs/${encodeURIComponent(item.cid)}`} target="_blank" rel="noopener noreferrer" className="external-link">Open submitted certificate PDF ↗</a>
    <form onSubmit={approve} className="cert-review-form">
      <label className="field"><span>Certificate number</span><input value={number} onChange={e => setNumber(e.target.value)} placeholder="Certificate reference" required maxLength={100} /></label>
      <div className="field-pair"><label className="field"><span>Issue date</span><input type="date" value={issueDate} onChange={e => setIssueDate(e.target.value)} required /></label>
      <label className="field"><span>Expiry date</span><input type="date" value={expiryDate} onChange={e => setExpiryDate(e.target.value)} required /></label></div>
      <button className="button-primary" type="submit" disabled={busy}>{busy ? 'Registering…' : 'Approve & register on Sepolia'}</button>
    </form>
    {error && <p className="error-message" role="alert">{error}</p>}{message && <p className="success-message">{message}</p>}
  </article>
}

export function CertifierReview({ contract, enabled }) {
  const [items, setItems] = useState([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [loaded, setLoaded] = useState(false)
  async function refresh() {
    setBusy(true); setError('')
    try {
      if (!enabled || !contract || !window.ethereum) throw new Error('Connect a wallet with the Certifier role.')
      const provider = new BrowserProvider(window.ethereum)
      if ((await provider.getNetwork()).chainId !== CHAIN_ID) throw new Error('Select Sepolia.')
      const signer = await provider.getSigner()
      const walletAddress = await signer.getAddress()
      const start = await fetch(`${API}/api/certification-submissions/challenge`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ walletAddress }) })
      const challenge = await start.json()
      if (!start.ok) throw new Error(challenge.error || 'Certifier role required.')
      const signature = await signer.signMessage(challenge.message)
      const response = await fetch(`${API}/api/certification-submissions/list`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nonce: challenge.nonce, signature }) })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Unable to load certificate submissions.')
      const pending = await Promise.all((result.submissions || []).map(async item => {
        try {
          const certificate = await contract.getCertificate(BigInt(item.batchId))
          return certificate.exists ? null : item
        } catch (err) {
          if (/Certificate does not exist/i.test([err.reason, err.shortMessage, err.message].filter(Boolean).join(' '))) return item
          throw err
        }
      }))
      setItems(pending.filter(Boolean)); setLoaded(true)
    } catch (err) { setError(err.shortMessage || err.message) } finally { setBusy(false) }
  }
  if (!enabled || !contract) return null
  return <section className="form-card certifier-panel"><div className="card-topline"><span className="step-tag">CERTIFIER DASHBOARD</span><span className="mini-tag">Restricted access</span></div>
    <h2>Review farmer certificates</h2>
    <button className="button-outline" type="button" disabled={busy} onClick={refresh}>{busy ? 'Loading…' : 'Load pending submissions'}</button>
    {loaded && !items.length && <p className="card-description">No pending certificates.</p>}
    <div className="cert-review-list">{items.map(item => <ReviewItem key={item.batchId} item={item} contract={contract} busy={busy} setBusy={setBusy} onApproved={batchId => setItems(list => list.filter(x => x.batchId !== batchId))}/>)}</div>
    {error && <p className="error-message" role="alert">{error}</p>}
  </section>
}

/** Displayed only after a newly registered batch's document upload failed. */
export function CertificateUploadRetry({ batchId, onSuccess }) {
  const [file, setFile] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function submit(e) {
    e.preventDefault(); setBusy(true); setError('')
    try {
      await submitFarmerCertificate(batchId, file)
      onSuccess()
    } catch (err) { setError(err.message) } finally { setBusy(false) }
  }
  return <section className="form-card"><span className="step-tag">UPLOAD RECOVERY</span><h2>Finish certificate submission for Batch #{batchId}</h2>
    <form onSubmit={submit}><label className="field"><span>Certificate PDF</span><input type="file" accept=".pdf,application/pdf" required onChange={e => setFile(e.target.files?.[0] || null)}/></label>
      <button className="button-primary" type="submit" disabled={busy || !file}>{busy ? 'Submitting…' : 'Retry PDF submission'}</button></form>
    {error && <p className="error-message" role="alert">{error}</p>}
  </section>
}
