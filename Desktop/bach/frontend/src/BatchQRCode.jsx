import { QRCodeCanvas } from 'qrcode.react'
import { CHAIN_ID, CONTRACT_ADDRESS } from './sepoliaConfig.js'

/** A public link is encoded in the QR; no wallet key or certificate file is embedded. */
export default function BatchQRCode({ batchId }) {
  if (!batchId) return null

  const publicOrigin = (import.meta.env.VITE_PUBLIC_APP_URL || window.location.origin).replace(/\/$/, '')
   const url = `${publicOrigin}${window.location.pathname}?consumer=1&batch=${encodeURIComponent(batchId)}&chain=${CHAIN_ID}&contract=${CONTRACT_ADDRESS}`
  const canvasId = `organictrace-qr-${batchId}`

  function saveQRCode() {
    const canvas = document.getElementById(canvasId)
    if (!canvas) return
    const image = canvas.toDataURL('image/png')
    const a = document.createElement('a')
    a.href = image
    a.download = `organictrace-batch-${batchId}-qr.png`
    document.body.appendChild(a)
    a.click()
    a.remove()
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(url)
    } catch {
      window.prompt('Copy this consumer link:', url)
    }
  }

  return (
    <section className="qr-panel" aria-label={`QR code for batch ${batchId}`}>
      <div>
        <span className="step-tag">CONSUMER VERIFICATION</span>
        <h3>Batch #{batchId} QR code</h3>
        <p>Scan to open the product's public history and certificate status.</p>
        <div className="qr-actions">
          <a className="qr-link" href={url} target="_blank" rel="noopener noreferrer">Open consumer page ↗</a>
          <button type="button" className="qr-small-button" onClick={copyLink}>Copy link</button>
          <button type="button" className="qr-small-button" onClick={saveQRCode}>Download PNG</button>
        </div>
      </div>
      <div className="qr-image"><QRCodeCanvas id={canvasId} value={url} size={156} marginSize={2} level="M" title={`OrganicTrace batch ${batchId}`} /></div>
    </section>
  )
}
