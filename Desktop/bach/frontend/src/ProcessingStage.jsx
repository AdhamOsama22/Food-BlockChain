import { useState } from 'react'
import { BrowserProvider, Contract, isAddress } from 'ethers'
import { CHAIN_ID, CONTRACT_ADDRESS } from './sepoliaConfig.js'
import { PROCESSING_ADDRESS, PROCESSING_ABI, processingConfigured, loadProcessing } from './processingConfig.js'
import './ProcessingStage.css'

const FOOD_ABI = ['function batches(uint256) view returns (string productName,string farmName,uint256 harvestDate,address farmer,address currentHolder,bool exists,uint8 stage)']
const validBatchId = value => /^[1-9]\d*$/.test(String(value).trim())

export default function ProcessingStage() {
  const [batchId, setBatchId] = useState('')
  const [processor, setProcessor] = useState('')
  const [quantity, setQuantity] = useState('')
  const [date, setDate] = useState('')
  const [method, setMethod] = useState('')
  const [snapshot, setSnapshot] = useState(null)
  const [record, setRecord] = useState(null)
  const [account, setAccount] = useState('')
  const [approved, setApproved] = useState(false)
  const [assigned, setAssigned] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  async function contracts() {
    if (!processingConfigured) throw new Error('Deploy the Processing companion contract and set VITE_PROCESSING_CONTRACT_ADDRESS first.')
    if (!window.ethereum) throw new Error('Install MetaMask')
    const wallet = new BrowserProvider(window.ethereum)
    await wallet.send('eth_requestAccounts', [])
    if ((await wallet.getNetwork()).chainId !== CHAIN_ID) throw new Error('Select Ethereum Sepolia in MetaMask')
    const signer = await wallet.getSigner()
    const address = await signer.getAddress()
    const addon = new Contract(PROCESSING_ADDRESS, PROCESSING_ABI, signer)
    if (await wallet.getCode(PROCESSING_ADDRESS) === '0x') throw new Error('Processing contract not found on Sepolia')
    if ((await addon.foodTraceability()).toLowerCase() !== CONTRACT_ADDRESS.toLowerCase()) throw new Error('Wrong main contract reference')
    return { signer, address, addon, food: new Contract(CONTRACT_ADDRESS, FOOD_ABI, signer) }
  }

  async function run(action) {
    setError(''); setMessage(''); setBusy(true)
    try { await action() } catch (e) { setError(e.shortMessage || e.reason || e.message) } finally { setBusy(false) }
  }

  async function load() {
    await run(async () => {
      if (!validBatchId(batchId)) throw new Error('Enter a valid batch ID')
      const { address, addon, food } = await contracts()
      const id = BigInt(batchId)
      const b = await food.batches(id)
      if (!b.exists) throw new Error('This batch does not exist')
      const role = await addon.PROCESSOR_ROLE()
      setAccount(address)
      setSnapshot({ product: b.productName, farmer: b.farmer, stage: Number(b.stage), harvestDate: Number(b.harvestDate) })
      setRecord(await loadProcessing(batchId))
      setAssigned(await addon.assignedProcessor(id))
      setApproved(await addon.hasRole(role, address))
    })
  }

  async function assign() {
    await run(async () => {
      if (!validBatchId(batchId) || !isAddress(processor)) throw new Error('Enter batch ID and an approved Processor address')
      const { addon } = await contracts()
      const tx = await addon.assignProcessor(BigInt(batchId), processor)
      await tx.wait()
      setAssigned(processor)
      setMessage('Processor assigned to this batch on Sepolia.')
    })
  }

  async function save() {
    await run(async () => {
      if (!validBatchId(batchId)) throw new Error('Enter a valid batch ID')
      if (!/^\d+$/.test(quantity.trim()) || BigInt(quantity) === 0n) throw new Error('Enter received quantity as a positive whole number of kilograms')
      const timestamp = Math.floor(new Date(`${date}T00:00:00Z`).getTime() / 1000)
      if (!date || !Number.isFinite(timestamp)) throw new Error('Enter a valid processing date')
      if (!method.trim() || method.trim().length > 200) throw new Error('Enter a processing method (1–200 characters)')
      const { addon } = await contracts()
      const tx = await addon.recordProcessing(BigInt(batchId), BigInt(quantity), BigInt(timestamp), method.trim())
      const receipt = await tx.wait()
      if (receipt.status !== 1) throw new Error('Processing transaction failed')
      setRecord(await loadProcessing(batchId))
      setMessage(`Processing recorded in Sepolia block ${receipt.blockNumber}.`)
    })
  }

  if (!processingConfigured) return <section className="processing-wrap"><div className="processing-panel"><h2>Processing stage</h2><p>The optional on-chain Processing extension is not deployed yet. Deploy it and add <code>VITE_PROCESSING_CONTRACT_ADDRESS</code> to <code>frontend/.env</code>. Existing batches are unchanged.</p></div></section>
  const farmer = snapshot && account.toLowerCase() === snapshot.farmer.toLowerCase()
  const canProcess = snapshot && approved && snapshot.stage === 0 && assigned.toLowerCase() === account.toLowerCase() && !record?.exists
  return <div className="processing-wrap">
    <section className="processing-panel">
      <div className="step-tag">ON-CHAIN · PROCESSING FACILITY</div>
      <h2>Process an existing batch</h2>
      <p>Assign an approved processing facility or submit a processing record for this batch.</p>
      <label>Batch ID<input type="number" min="1" value={batchId} onChange={e=>setBatchId(e.target.value)} /></label>
      <button className="button-primary" type="button" disabled={busy} onClick={load}>Load batch & permissions</button>
      {snapshot && <div className="processing-summary"><strong>{snapshot.product} — Batch #{batchId}</strong><span>{snapshot.stage === 0 ? 'Currently at Farmer stage' : 'Batch has already left Farmer stage'}</span></div>}
      {record?.exists && <div className="processing-summary"><strong>Processing already confirmed</strong><span>Received: {record.quantityKg} kg · Method: {record.method}</span><span>Block #{record.block}</span></div>}
      {error && <p className="processing-error" role="alert">{error}</p>}
      {message && <p className="processing-ok" role="status">{message}</p>}
    </section>
    {snapshot && <div className="processing-grid">
      {farmer && <section className="processing-panel"><div className="step-tag">FARMER</div><h3>Assign a processing facility</h3><p>The Processor must first receive the Processor role from the Admin.</p><label>Approved Processor wallet address<input value={processor} onChange={e=>setProcessor(e.target.value)} placeholder="0x..." /></label><button className="button-primary" disabled={busy || snapshot.stage !== 0 || record?.exists} type="button" onClick={assign}>Assign Processor</button></section>}
      {approved && <section className="processing-panel"><div className="step-tag">PROCESSOR</div><h3>Record processing</h3><p>Assigned Processor: {assigned && assigned !== '0x0000000000000000000000000000000000000000' ? 'Assigned' : 'Not assigned'}</p><label>Quantity received (kg)<input type="number" min="1" step="1" value={quantity} onChange={e=>setQuantity(e.target.value)} /></label><label>Processing date<input type="date" value={date} onChange={e=>setDate(e.target.value)} /></label><label>Processing method<input maxLength="200" value={method} onChange={e=>setMethod(e.target.value)} placeholder="e.g. washed, sorted and packed" /></label><button className="button-primary" disabled={busy || !canProcess} type="button" onClick={save}>Submit</button></section>}
      {!farmer && !approved && <section className="processing-panel"><p>Your connected wallet is neither this batch’s Farmer nor an approved Processor.</p></section>}
    </div>}
  </div>
}
