import { useEffect, useState } from 'react'
import { BrowserProvider } from 'ethers'
import { CHAIN_ID } from './sepoliaConfig'
import './BatchMetadata.css'

const API = (import.meta.env.VITE_API_BASE_URL || (import.meta.env.PROD ? '' : 'http://127.0.0.1:3001')).replace(/\/$/, '')
const gateway = (import.meta.env.VITE_IPFS_GATEWAY || 'https://gateway.pinata.cloud/ipfs/').replace(/\/$/, '') + '/'
export const metadataImageUrl = cid => cid && /^[a-zA-Z0-9]+$/.test(cid) ? `${gateway}${cid}` : ''

export async function fetchBatchMetadata(batchId) {
  const response = await fetch(`${API}/api/batches/${encodeURIComponent(batchId)}/details`, { cache: 'no-store' })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error || 'Unable to load batch metadata.')
  return result
}

export async function saveSignedMetadata(batchId, kind, payload, image) {
  if (!window.ethereum) throw new Error('MetaMask is required to sign this update.')
  const provider = new BrowserProvider(window.ethereum)
  const chain = await provider.getNetwork()
  if (chain.chainId !== CHAIN_ID) throw new Error('Switch MetaMask to Sepolia.')
  const signer = await provider.getSigner()
  const walletAddress = await signer.getAddress()
  const endpoint = `${API}/api/batches/${encodeURIComponent(batchId)}/metadata`
  const challengeResponse = await fetch(`${endpoint}/challenge`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ walletAddress, kind, payload })
  })
  const challenge = await challengeResponse.json()
  if (!challengeResponse.ok) throw new Error(challenge.error || 'Wallet not authorized.')
  const signature = await signer.signMessage(challenge.message)
  const form = new FormData()
  form.append('nonce', challenge.nonce)
  form.append('signature', signature)
  if (image) form.append('image', image)
  const response = await fetch(endpoint, { method: 'PUT', body: form })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || 'Could not save details.')
  return data
}

export async function imageSha256(file) {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
  return Array.from(new Uint8Array(digest)).map(x => x.toString(16).padStart(2, '0')).join('')
}

/** Shows the saved farm information together with the on-chain batch summary.
 * MongoDB is the source for location/photo, not the Solidity batches getter.
 */
export function BatchMetadataSummary({ batchId, reloadKey = 0, allowQuantityBackfill = false }) {
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')
  const [legacyQuantity, setLegacyQuantity] = useState('')
  const [legacyLocation, setLegacyLocation] = useState('')
  const [savingLegacy, setSavingLegacy] = useState(false)
  const [legacyMessage, setLegacyMessage] = useState('')
  useEffect(() => {
    let active = true
    setResult(null)
    setError('')
    if (batchId) fetchBatchMetadata(batchId).then(data => {
      if (active) setResult(data)
    }).catch(err => {
      if (active) setError(err.message)
    })
    return () => { active = false }
  }, [batchId, reloadKey])
  const details = result?.details
  async function backfillQuantity(event) {
    event.preventDefault()
    setSavingLegacy(true)
    setLegacyMessage('')
    try {
      const number = Number(legacyQuantity)
      if (!Number.isFinite(number) || number <= 0 || number > 1e12) throw new Error('Enter a valid original quantity in kg.')
      const farmLocation = (details?.farmLocation || legacyLocation).trim()
      if (!farmLocation) throw new Error('Enter the original farm location.')
      await saveSignedMetadata(batchId, 'farm', { farmLocation, description: details?.description || '', imageHash: '', quantityKg: number }, null)
      setResult(await fetchBatchMetadata(batchId))
      setLegacyMessage('Original quantity saved for this existing batch.')
    } catch (err) { setLegacyMessage(err.message) } finally { setSavingLegacy(false) }
  }
  return <div className="batch-extra-summary">
    {error ? <p className="batch-extra-note" role="status">Farm details unavailable: {error}</p> : !result ? <p className="batch-extra-note">Loading farm details…</p> : <>
      {details?.imageCid && <img className="batch-summary-photo" src={metadataImageUrl(details.imageCid)} alt={`Product photo for batch ${batchId}`} loading="lazy" />}
      <div className="detail-list">
        <div><span>Farm location</span><strong>{details?.farmLocation || 'Not saved for this batch'}</strong></div>
        <div><span>Batch quantity</span><strong>{Number(details?.quantityKg) > 0 ? `${details.quantityKg} kg` : 'Not recorded (older batch)'}</strong></div>
        {details?.description && <div><span>Farm description</span><strong>{details.description}</strong></div>}
        {details?.imageCid && <div><span>Product photo</span><a className="external-link" href={metadataImageUrl(details.imageCid)} target="_blank" rel="noopener noreferrer">View full image</a></div>}
        <div><span>Recorded shipments</span><strong>{details?.shipments?.length || 0}</strong></div>
      </div>
      {allowQuantityBackfill && !(Number(details?.quantityKg) > 0) && <form onSubmit={backfillQuantity} className="batch-legacy-quantity-form">
        <p className="card-description">Older batch: add the original quantity once. This does not create a new blockchain batch.</p>
        {!details?.farmLocation && <label className="field"><span>Original farm location</span><input required maxLength={200} value={legacyLocation} onChange={e => setLegacyLocation(e.target.value)} /></label>}
        <label className="field"><span>Original quantity (kg)</span><input required type="number" min="0.001" max="1000000000000" step="any" value={legacyQuantity} onChange={e => setLegacyQuantity(e.target.value)} /></label>
        <button type="submit" className="button-outline" disabled={savingLegacy}>{savingLegacy ? 'Saving…' : 'Save original quantity'}</button>
        {legacyMessage && <p role="status" className="card-description">{legacyMessage}</p>}
      </form>}
    </>}
  </div>
}

export function BatchMetadataView({ batchId, reloadKey = 0, showShipments = true }) {
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    setResult(null); setError('')
    if (!batchId) return () => { active = false }
    fetchBatchMetadata(batchId).then(data => { if (active) setResult(data) }).catch(err => { if (active) setError(err.message) })
    return () => { active = false }
  }, [batchId, reloadKey])
  if (!batchId) return null
  const data = result?.details
  if (result && !data) return null
  return <section className="result-card metadata-display">
    <div className="result-head"><div><span className="step-tag">OFF-CHAIN INFORMATION · MONGODB / IPFS</span><h2>Farm and transportation details</h2></div></div>

    {error && <p role="alert" className="error-message">Additional details unavailable: {error}</p>}
    {!error && !result && <p className="card-description">Loading additional details…</p>}
    {result && !data && <p className="card-description">No extra farm or transport details have been recorded yet.</p>}
    {data && <>
      {data.imageCid && <img className="batch-photo" src={metadataImageUrl(data.imageCid)} alt={`Photo submitted for batch ${batchId}`} loading="lazy" />}
      <div className="detail-list">
        <div><span>Farm location (off-chain)</span><strong>{data.farmLocation || 'Not provided'}</strong></div>
        <div><span>Registered batch quantity</span><strong>{Number(data.quantityKg) > 0 ? `${data.quantityKg} kg` : 'Not recorded (older batch)'}</strong></div>
        {data.description && <div><span>Farm description</span><strong>{data.description}</strong></div>}
        {data.imageCid && <div><span>Product image</span><a className="external-link" href={metadataImageUrl(data.imageCid)} target="_blank" rel="noopener noreferrer">View image on IPFS</a></div>}
      </div>
      {showShipments && <>
      <h3>Shipment records ({data.shipments?.length || 0})</h3>
      {!data.shipments?.length && <p className="card-description">No off-chain shipments recorded yet.</p>}
      {(data.shipments || []).map(item => <div className="shipment-card" key={item.recordId}>
        <strong>Shipment {item.shipmentId}</strong><span className="mini-tag">Off-chain</span>
        <div className="detail-list">
          <div><span>Route</span><strong>{item.source} → {item.destination}</strong></div>
          <div><span>Transporter</span><strong>{item.transporter}</strong></div>
          <div><span>Quantity</span><strong>{item.quantity} {item.unit}</strong></div>
          <div><span>Dispatch / arrival (UTC)</span><strong>{item.dispatchTime} / {item.arrivalTime || 'Not recorded'}</strong></div>
        </div>
      </div>)}
      </>}
    </>}
  </section>
}

export default function BatchMetadataEditor({ account, mode = "both", initialBatchId = "" }) {
  const [batchId, setBatchId] = useState(initialBatchId)
  const [farmLocation, setFarmLocation] = useState('')
  const [quantityKg, setQuantityKg] = useState('')
  const [description, setDescription] = useState('')
  const [image, setImage] = useState(null)
  const [shipment, setShipment] = useState({ shipmentId: '', source: '', destination: '', transporter: '', dispatchTime: '', arrivalTime: '' })
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [reloadKey, setReloadKey] = useState(0)
  const [existing, setExisting] = useState(null)
  async function loadDetails(event) {
    event?.preventDefault()
    setError(''); setMessage('')
    try {
      const data = await fetchBatchMetadata(batchId)
      setExisting(data)
      setFarmLocation(data.details?.farmLocation || '')
      setQuantityKg(data.details?.quantityKg ? String(data.details.quantityKg) : '')
      setDescription(data.details?.description || '')
      setReloadKey(x => x + 1)
    } catch (err) { setError(err.message) }
  }
  async function submit(kind, event) {
    event.preventDefault(); setBusy(true); setError(''); setMessage('')
    try {
      if (!account) throw new Error('Connect MetaMask first.')
      if (!/^[1-9]\d*$/.test(batchId)) throw new Error('Enter a valid batch ID.')
      let payload
      if (kind === 'farm') {
        if (image && (!['image/jpeg', 'image/png', 'image/webp'].includes(image.type) || image.size > 5 * 1024 * 1024)) throw new Error('Select a JPG, PNG or WebP image under 5 MB.')
        payload = { farmLocation, description, quantityKg: quantityKg === '' ? null : Number(quantityKg), imageHash: image ? await imageSha256(image) : '' }
      } else {
        payload = { shipmentId: shipment.shipmentId, source: shipment.source, destination: shipment.destination, transporter: shipment.transporter, dispatchTime: shipment.dispatchTime, arrivalTime: shipment.arrivalTime }
      }
      await saveSignedMetadata(batchId, kind, payload, kind === 'farm' ? image : null)
      setMessage(kind === 'farm' ? 'Farm details and image saved to MongoDB / IPFS.' : 'Shipment appended to MongoDB successfully.')
      if (kind === 'shipment') setShipment({ shipmentId: '', source: '', destination: '', transporter: '', dispatchTime: '', arrivalTime: '' })
      if (kind === 'farm') setImage(null)
      await loadDetails()
      setMessage(kind === 'farm' ? 'Farm details and image saved.' : 'Shipment saved.')
    } catch (err) { setError(err.message) } finally { setBusy(false) }
  }
  useEffect(() => { if (initialBatchId) { setBatchId(String(initialBatchId)); setExisting(null) } }, [initialBatchId])
  const shipmentField = (key, title, type = 'text', required = true) => <label className="field" key={key}><span>{title}</span><input type={type} required={required} step={type === 'number' ? 'any' : undefined} value={shipment[key]} onChange={e => setShipment(old => ({ ...old, [key]: e.target.value }))} /></label>
  return <div className="metadata-editor">
    <section className="form-card"><span className="step-tag">SELECT EXISTING SEPOLIA BATCH</span><h2>Batch details</h2>
      
      <form onSubmit={loadDetails}><label className="field"><span>Batch ID</span><input required type="number" min="1" step="1" value={batchId} onChange={e => { setBatchId(e.target.value); setExisting(null); setMessage(''); setError('') }} placeholder="e.g. 1" /></label><button className="button-outline" type="submit">Load this batch</button></form>
      {error && <p className="error-message" role="alert">{error}</p>}{message && <p className="success-message" role="status">{message}</p>}
    </section>
    {existing && <><div className="feature-layout">
      {(mode === 'both' || mode === 'farm') && <section className="form-card"><span className="step-tag">FARMER SIGNATURE REQUIRED</span><h2>Farm details</h2>
        <form onSubmit={e => submit('farm', e)}>
          <label className="field"><span>Original batch quantity (kg)</span><input type="number" min="0.001" max="1000000000000" step="any" value={quantityKg} disabled={Number(existing?.details?.quantityKg) > 0} onChange={e => setQuantityKg(e.target.value)} placeholder="Required if missing for older batches" /><small>{Number(existing?.details?.quantityKg) > 0 ? 'Original batch quantity is locked after being saved.' : 'For batches created before this update, enter the original quantity only once.'}</small></label>
          <label className="field"><span>Farm location</span><input required maxLength={200} value={farmLocation} onChange={e => setFarmLocation(e.target.value)} placeholder="e.g. Fayoum, Egypt" /></label>
          <label className="field"><span>Farm description (optional)</span><textarea maxLength={500} value={description} onChange={e => setDescription(e.target.value)} placeholder="Farm and growing methods" /></label>
          <label className="field"><span>Product image (optional, JPG/PNG/WebP, max 5 MB)</span><input type="file" accept="image/jpeg,image/png,image/webp" onChange={e => setImage(e.target.files?.[0] || null)} /></label>
          <button className="button-primary" type="submit" disabled={busy || !account}>Sign & save farm details</button>
        </form>
      </section>}
      {(mode === 'both' || mode === 'shipment') && <section className="form-card" style={mode === 'shipment' ? { gridColumn: '1 / -1', width: '100%', maxWidth: 740, margin: '0 auto' } : undefined}><span className="step-tag">CURRENT HOLDER SIGNATURE REQUIRED</span><h2>Record transportation</h2>
        <form onSubmit={e => submit('shipment', e)}>
          <p className="card-description">{Number(existing?.details?.quantityKg) > 0 ? `Batch quantity: ${existing.details.quantityKg} kg (recorded at registration)` : 'This older batch has no registered quantity. Its farmer must save an initial batch quantity before recording a new shipment.'}</p>
          {shipmentField('shipmentId', 'Shipment ID')}
          {shipmentField('source', 'Source')}{shipmentField('destination', 'Destination')}{shipmentField('transporter', 'Transporter')}
          {shipmentField('dispatchTime', 'Dispatch (UTC)', 'datetime-local')}{shipmentField('arrivalTime', 'Arrival (UTC, optional)', 'datetime-local', false)}
          <button className="button-primary" type="submit" disabled={busy || !account}>Sign & record shipment</button>
        </form>
      </section>}
    </div><BatchMetadataView batchId={batchId} reloadKey={reloadKey}/></>}
  </div>
}
