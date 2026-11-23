import { useEffect, useState } from 'react'
import { Contract, JsonRpcProvider } from 'ethers'
import BatchQRCode from './BatchQRCode'
import { loadProcessing, processingConfigured } from './processingConfig.js'
import { BatchMetadataView, fetchBatchMetadata } from './BatchMetadata'
import { participantName, loadParticipantNames, PARTICIPANTS_UPDATED } from './participantNames'
import { PUBLIC_RPC_URL, CHAIN_ID, CONTRACT_ADDRESS } from './sepoliaConfig.js'
import { getBatchEvents } from './verifiedBatchEvents.js'
import './OrganicTraceVerification.css'
import ShipmentIntegrityTag from './ShipmentIntegrityTag.jsx'
import { verifyShipmentIntegrity } from './shipmentIntegrity.js'
import './ShipmentIntegrity.css'

const STAGES = ['Farmer', 'Distributor', 'Retailer']
const IPFS_GATEWAY = 'https://teal-fantastic-fowl-808.mypinata.cloud/ipfs/'

function displayDate(value) {
  const seconds = Number(value)
  if (!Number.isFinite(seconds) || seconds <= 0) return 'Not available'
  return new Date(seconds * 1000).toLocaleDateString('en-GB', {
    timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric'
  })
}

function customerName(address) {
  return participantName(address) || 'Name not available'
}

function shorten(address) {
  return address ? `${address.slice(0, 9)}…${address.slice(-7)}` : 'Unknown'
}

async function getHistory(readContract, id) {
  const events = await getBatchEvents(readContract.interface, id.toString(), readContract.target)
  const convert = event => ({
    block: event.blockNumber,
    index: event.index,
    hash: event.transactionHash,
    wallets: event.wallets
  })
  return {
    registration: events.filter(e => e.name === 'BatchRegistered').map(convert),
    transfers: events.filter(e => e.name === 'BatchTransferred').map(convert)
  }
}

export default function PublicConsumer({ initialBatchId = '', abi, contractAddress }) {
  const [inputId, setInputId] = useState(initialBatchId)
  const [record, setRecord] = useState(null)
  const [certificate, setCertificate] = useState(null)
  const [history, setHistory] = useState(null)
  const [historyError, setHistoryError] = useState('')
  const [processing, setProcessing] = useState(null)
  const [processingError, setProcessingError] = useState('')
  const [shipments, setShipments] = useState([])
  const [shipmentError, setShipmentError] = useState('')
  const [shipmentVerification, setShipmentVerification] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [, updateNames] = useState(0)

  useEffect(() => {
    const onUpdated = () => updateNames(v => v + 1)
    window.addEventListener(PARTICIPANTS_UPDATED, onUpdated)
    loadParticipantNames().catch(err => console.warn('Could not load participant names:', err.message))
    return () => window.removeEventListener(PARTICIPANTS_UPDATED, onUpdated)
  }, [])

  async function readBatch(rawId) {
    const value = rawId.trim()
    const qrParams = new URLSearchParams(window.location.search)
    const qrChain = qrParams.get('chain')
    const qrContract = qrParams.get('contract')
    if ((qrChain && qrChain !== CHAIN_ID.toString()) || (qrContract && qrContract.toLowerCase() !== CONTRACT_ADDRESS.toLowerCase())) {
      setError('This QR code belongs to a different blockchain or contract.')
      return
    }
    setError('')
    setRecord(null)
    setCertificate(null)
    setHistory(null)
    setHistoryError('')
    if (!/^[1-9]\d*$/.test(value)) {
      setError('Enter a valid batch ID (1, 2, 3, ...).')
      return
    }

    setBusy(true)
    try {
      // Read-only RPC. This never asks MetaMask to connect or sign anything.
      const provider = new JsonRpcProvider(PUBLIC_RPC_URL, Number(CHAIN_ID), { staticNetwork: true })
      const code = await provider.getCode(contractAddress)
      if (code === '0x') throw new Error('The OrganicTrace smart contract was not found on Sepolia.')
      const reader = new Contract(contractAddress, abi, provider)
      const id = BigInt(value)
      const nextId = await reader.nextBatchId()
      if (id >= nextId) throw new Error(`Batch #${value} does not exist on the running blockchain.`)
      const result = await reader.batches(id)
      if (!result.exists) throw new Error(`Batch #${value} does not exist on the running blockchain.`)

      const batchData = {
        id: value,
        product: result.productName,
        farm: result.farmName,
        date: displayDate(result.harvestDate),
        farmer: result.farmer,
        holder: result.currentHolder,
        stage: STAGES[Number(result.stage)] ?? 'Unknown'
      }
      // Optional history reads must never hide a valid on-chain batch record.
      let eventHistory = null
      try { eventHistory = await getHistory(reader, id) }
      catch (historyFailure) { setHistoryError('Event history is temporarily unavailable. Batch data and certificate status are still verified.'); console.warn(historyFailure) }
      let certData = null
      let cert = null
      try {
        cert = await reader.getCertificate(id)
      } catch (err) {
        // The Solidity getter reverts when there is no certificate. A registered
        // batch without a certificate is valid for public traceability.
        const reason = [err.reason, err.shortMessage, err.message].filter(Boolean).join(' ')
        if (!/Certificate does not exist/i.test(reason)) throw err
      }
      const exists = cert ? (cert.exists ?? cert[6]) : false
      if (exists) {
        certData = {
          number: cert.certificateNumber ?? cert[0],
          cid: cert.ipfsCid ?? cert[1],
          hash: cert.fileHash ?? cert[2],
          issued: displayDate(cert.issueDate ?? cert[3]),
          expiry: displayDate(cert.expiryDate ?? cert[4]),
          issuer: cert.certifier ?? cert[5],
          revoked: cert.revoked ?? cert[7],
          valid: await reader.isCertificateValid(id)
        }
      }
      setRecord(batchData)
      setHistory(eventHistory)
      setCertificate(certData)
    } catch (err) {
      console.error('Public verification failed:', err)
      setError(err.shortMessage || err.reason || err.message || 'Cannot read Sepolia. Check the public RPC connection.')
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (initialBatchId) readBatch(initialBatchId)
    // Load the batch encoded in a scanned QR on first visit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialBatchId])

  useEffect(() => {
    let active = true
    setProcessing(null)
    setProcessingError('')
    setShipments([])
    setShipmentError('')
    if (!record?.id) return () => { active = false }
    if (processingConfigured) {
      loadProcessing(record.id)
        .then(data => { if (active) setProcessing(data) })
        .catch(err => { if (active) setProcessingError(err.message) })
    }
    fetchBatchMetadata(record.id)
      .then(data => { if (active) setShipments(data.details?.shipments || []) })
      .catch(err => { if (active) setShipmentError(err.message) })
    return () => { active = false }
  }, [record?.id])

  // Verify each shipment independently when this batch's MongoDB records arrive.
  // Never reuse a previous batch's result, and never treat RPC errors as success.
  useEffect(() => {
    let active = true
    setShipmentVerification(null)
    if (!record?.id || !shipments.length) return () => { active = false }

    Promise.all(shipments.map(async shipment => {
      if (!shipment?.shipmentId) return 'not-anchored'
      try {
        const result = await verifyShipmentIntegrity(record.id, shipment)
        return result.status
      } catch {
        return 'unavailable'
      }
    })).then(statuses => {
      if (active) setShipmentVerification({ batchId: record.id, shipments, statuses })
    })
    return () => { active = false }
  }, [record?.id, shipments])

  const checkedShipments = shipmentVerification?.batchId === record?.id &&
    shipmentVerification?.shipments === shipments ? shipmentVerification.statuses : null
  const transportVerified = shipments.length > 0 &&
    checkedShipments?.length === shipments.length &&
    checkedShipments.every(status => status === 'verified')
  const transportMismatch = checkedShipments?.some(status => status === 'modified')
  const transportPending = shipments.length > 0 && checkedShipments === null
  const transportUnavailable = Boolean(shipmentError) ||
    checkedShipments?.some(status => status === 'unavailable' || status === 'unconfigured')

  // A stage-order summary, not a claim of timestamp ordering across data sources.
  // Ownership and processing are validated on-chain; transport is MongoDB-sourced.
  const journey = []
  if (record) {
    for (const log of history?.registration || []) {
      journey.push({ key: `farmer-${log.hash}`, label: 'Farmer — batch registered', description: `Farm: ${record.farm} · Batch #${record.id}`, provenance: `On-chain · Block #${log.block} · Transaction ${shorten(log.hash)}` })
    }
    if (processing?.exists) {
      journey.push({ key: 'processor', label: 'Processing completed', description: `${processing.quantityKg} kg · ${processing.method} · ${displayDate(processing.date)}`, provenance: `On-chain Processing contract · Block #${processing.block}` })
    }
    const transfers = history?.transfers || []
    const addShipment = (item, i) => journey.push({
      key: `transport-${item.recordId || i}-${i}`,
      shipment: item,
      label: 'Transportation recorded',
      description: `Shipment ${item.shipmentId} · ${item.source} → ${item.destination} · ${item.transporter || 'Transporter not provided'}${item.quantity ? ` · ${item.quantity} ${item.unit || 'kg'}` : ''}`,
      provenance: 'Off-chain · MongoDB shipment record'
    })
    if (shipments.length) addShipment(shipments[0], 0)
    transfers.forEach((log, index) => {
      journey.push({
        key: `transfer-${log.hash}-${index}`,
        label: index === 0 ? 'Transferred to Distributor' : index === 1 ? 'Transferred to Retailer' : 'Ownership transferred',
        description: log.wallets.length ? log.wallets.map(customerName).join(' → ') : '',
        provenance: `On-chain · Block #${log.block} · Transaction ${shorten(log.hash)}`
      })
      if (shipments[index + 1]) addShipment(shipments[index + 1], index + 1)
    })
    for (let i = transfers.length + 1; i < shipments.length; i++) addShipment(shipments[i], i)
  }

  function search(event) {
    event.preventDefault()
    const search = new URLSearchParams(window.location.search)
    search.set('consumer', '1')
    search.set('batch', inputId.trim())
    window.history.replaceState(null, '', `${window.location.pathname}?${search}`)
    readBatch(inputId)
  }

  return (
    <div className="consumer-page">
      <section className="consumer-hero">
        <span className="step-tag">PUBLIC PRODUCT VERIFICATION</span>
        <h2>Know where your food came from.</h2>
        <p>Read the product's blockchain record, its actual custody events and organic certificate status. No wallet or login required.</p>
        <form className="consumer-search" onSubmit={search}>
          <label className="field"><span>Food batch ID</span><input type="number" min="1" step="1" value={inputId} onChange={e => setInputId(e.target.value)} placeholder="Enter a batch ID, e.g. 2" required /></label>
          <button type="submit" className="button-primary" disabled={busy}>{busy ? 'Checking blockchain…' : 'Verify product →'}</button>
        </form>
      </section>

      {error && <div className="notice consumer-error" role="alert"><span className="notice-symbol">!</span><div><strong>Unable to verify this batch</strong><p>{error}</p></div></div>}

      {record && (
        <>
          <div className="consumer-columns">
            <section className="result-card">
              <div className="result-head"><div><span className="step-tag">BLOCKCHAIN RECORD</span><h2>{record.product}</h2></div><span className="status-chip">{record.stage}</span></div>
              <p className="card-description">Batch #{record.id} · Directly retrieved from the smart contract</p>
              <div className="detail-list">
                <div><span>Farm / origin</span><strong>{record.farm}</strong></div>
                <div><span>Harvest date</span><strong>{record.date}</strong></div>
                <div><span>Farmer name</span><strong>{customerName(record.farmer)}</strong></div>
                <div><span>Current holder name</span><strong>{customerName(record.holder)}</strong></div>
                <div><span>Current supply-chain stage</span><strong>{record.stage}</strong></div>
              </div>
            </section>
            <section className="result-card">
              <div className="result-head"><div><span className="step-tag">ORGANIC CERTIFICATION</span><h2>Certificate status</h2></div><span className={`status-chip ${!certificate?.valid ? 'invalid' : ''}`}>{!certificate ? 'Not registered' : certificate.valid ? 'Valid' : 'Invalid'}</span></div>
              {!certificate ? (
                <p className="card-description">No certificate available.</p>
              ) : (
                <>
                  <div className="detail-list">
                    <div><span>Certificate number</span><strong>{certificate.number}</strong></div>
                    <div><span>Issue date</span><strong>{certificate.issued}</strong></div>
                    <div><span>Expiry date</span><strong>{certificate.expiry}</strong></div>
                    <div><span>Revoked</span><strong>{certificate.revoked ? 'Yes' : 'No'}</strong></div>
                    <div><span>Certifier name</span><strong>{customerName(certificate.issuer)}</strong></div>
                    <div><span>File hash (SHA-256)</span><strong className="break-anywhere">{certificate.hash}</strong></div>
                  </div>
                  <a className="external-link" href={`${IPFS_GATEWAY}${encodeURIComponent(certificate.cid)}`} target="_blank" rel="noopener noreferrer">View certificate PDF on IPFS ↗</a>
                  {!certificate.valid && <p className="consumer-warning">This certificate is not currently valid. Do not treat this product as certified on the basis of this document.</p>}
                </>
              )}
            </section>
          </div>

          <section className="result-card ot-verification" aria-label="Product verification summary">
            <div className="result-head"><div><span className="step-tag">PRODUCT VERIFICATION</span><h2>Product verification</h2></div></div>
            <div className="ot-verification-heading"><div><strong>{record.product}</strong><span>Batch #{record.id}</span></div><span className={`ot-certificate-pill ${certificate?.valid ? 'is-valid' : ''}`}>{certificate?.valid ? '✓ Certified' : certificate ? 'Certification invalid' : 'Not certified'}</span></div>
            <div className="ot-verification-facts">
              <div><span>Origin</span><strong>{record.farm}</strong></div>
              <div><span>Harvest</span><strong>{record.date}</strong></div>
            </div>
            <h3 className="ot-verification-subtitle">Supply Chain</h3>
            <ul className="ot-verification-stages" aria-label="Supply chain verification">
              {[
                { label: 'Farm', ok: Boolean(history?.registration?.length), pending: Boolean(historyError) },
                { label: 'Processing', ok: Boolean(processing?.exists), pending: !processingConfigured || Boolean(processingError) || processing === null },
                {
                  label: 'Transportation',
                  ok: transportVerified,
                  recorded: !transportVerified && shipments.length > 0 && !transportMismatch && !transportPending && !transportUnavailable,
                  pending: transportPending || transportUnavailable,
                  mark: transportVerified ? '✓' : transportMismatch ? 'Mismatch' : transportPending ? 'Checking…' :
                    transportUnavailable ? 'Unavailable' : shipments.length > 0 ? 'Recorded' : '○'
                },
                { label: 'Distribution', ok: Boolean(history?.transfers?.[0]), pending: Boolean(historyError) },
                { label: 'Retail', ok: Boolean(history?.transfers?.[1]), pending: Boolean(historyError) }
              ].map(stage => <li className="ot-verification-stage" key={stage.label}>
                <span className="ot-stage-name">{stage.label}</span>
                <span className={`ot-stage-mark ${stage.ok ? 'is-complete' : ''} ${stage.recorded || (stage.mark && stage.mark !== '✓' && stage.mark !== '○') ? 'is-recorded' : ''}`} aria-label={`${stage.label}: ${stage.ok ? 'Verified' : stage.mark === 'Mismatch' ? 'Integrity mismatch' : stage.mark === 'Checking…' ? 'Checking integrity' : stage.pending ? 'Unavailable' : stage.recorded ? 'Recorded, not fully verified' : 'Not confirmed'}`}>
                  {stage.mark ?? (stage.ok ? '✓' : stage.recorded ? 'Recorded' : stage.pending ? '—' : '○')}
                </span>
              </li>)}
            </ul>
            <div className="ot-verification-status"><strong>Blockchain status</strong><span className={history?.registration?.length ? 'is-verified' : ''}>{history?.registration?.length ? '✓ Verified' : historyError ? 'Unavailable' : 'Not confirmed'}</span></div>
          </section>
          <section className="result-card journey-history">
            <div className="result-head"><div><span className="step-tag">PRODUCT TRACEABILITY</span><h2>Product journey</h2></div></div>
            <p className="card-description">Actual on-chain registration, processing and ownership transfers, together with separately labeled MongoDB shipment records. The sequence groups records by supply-chain stage; it does not prove exact ordering between off-chain and on-chain records.</p>
            {historyError && <p className="consumer-warning" role="status">{historyError}</p>}
            {!processingConfigured && <p className="consumer-warning" role="status">Processing contract address is not configured in this build.</p>}
            {processingError && <p className="consumer-warning" role="status">Processing information unavailable: {processingError}</p>}
            {shipmentError && <p className="consumer-warning" role="status">Transportation information unavailable: {shipmentError}</p>}
            {journey.length ? <ol className="timeline">
              {journey.map(item => <li key={item.key} className="timeline-event"><span className="timeline-dot" /><div><strong>{item.label}</strong>{item.description && <p>{item.description}</p>}<small>{item.provenance}</small>{item.shipment && <ShipmentIntegrityTag batchId={record.id} shipment={item.shipment} />}</div></li>)}
            </ol> : <p className="card-description">No timeline events are available yet. This does not mean the batch is missing from Sepolia.</p>}
          </section>
          <BatchMetadataView batchId={record.id} showShipments={false} />
          <BatchQRCode batchId={record.id} />
        </>
      )}
      {!record && !busy && !error && <section className="consumer-empty">Enter a batch ID or scan its QR code to see the verified record.</section>}
    </div>
  )
}
