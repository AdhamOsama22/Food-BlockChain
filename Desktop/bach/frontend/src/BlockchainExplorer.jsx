import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Contract, Interface, JsonRpcProvider, formatEther, id as keccakId } from 'ethers'
import { walletDisplay, PARTICIPANTS_UPDATED, loadParticipantNames } from './participantNames'

// Present participant names cleanly; retain wallet addresses in the technical explorer.
const participantDisplay = address => walletDisplay(address).replace(/\s*\(MongoDB label\)/gi, '')
import { PUBLIC_RPC_URL, CHAIN_ID, getEventStartBlock } from './sepoliaConfig'
import { getBatchEvents } from './verifiedBatchEvents'
import { loadProcessing, processingConfigured, PROCESSING_ADDRESS } from './processingConfig.js'
import './BlockchainExplorerDashboard.css'

const RECENT_BLOCKS = 10
const MAX_RECENT_TRANSACTIONS = 40
const BATCH_PAGE_SIZE = 15
const BLOCK_TRANSACTIONS_PAGE_SIZE = 10

function shorten(value, left = 12, right = 8) {
  if (!value) return '—'
  return value.length > left + right + 3 ? `${value.slice(0, left)}…${value.slice(-right)}` : value
}

function localTime(seconds) {
  return seconds ? new Date(Number(seconds) * 1000).toLocaleString() : '—'
}

function contractAction(tx, contractAddress, contractInterface) {
  if (!tx.to) return 'Contract deployment'
  if (tx.to.toLowerCase() !== contractAddress.toLowerCase()) return 'Wallet / other transaction'
  try {
    const parsed = contractInterface.parseTransaction({ data: tx.data, value: tx.value })
    const labels = {
      registerBatch: 'Register batch',
      transferBatch: 'Transfer batch',
      registerCertificate: 'Register certificate',
      revokeCertificate: 'Revoke certificate',
      grantRole: 'Grant role',
      revokeRole: 'Revoke role',
      renounceRole: 'Renounce role'
    }
    return parsed ? (labels[parsed.name] || parsed.name) : 'Contract interaction'
  } catch {
    return 'Contract interaction'
  }
}

// All application details below come from transaction input, emitted events, or
// (separately labelled) CURRENT contract state. No guessed product names or roles.
const ROLE_NAMES = Object.fromEntries(
  ['DEFAULT_ADMIN_ROLE', 'FARMER_ROLE', 'DISTRIBUTOR_ROLE', 'RETAILER_ROLE', 'CERTIFIER_ROLE']
    .map(name => [name === 'DEFAULT_ADMIN_ROLE' ? `0x${'0'.repeat(64)}` : keccakId(name).toLowerCase(), name.replace('_ROLE', '').replaceAll('_', ' ')])
)

function readable(value) {
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (typeof value === 'string') return ROLE_NAMES[value.toLowerCase()] || value
  if (Array.isArray(value)) return value.map(readable).join(' · ')
  return String(value ?? '—')
}

function prettyName(name) {
  const known = {
    batchId: 'Batch ID', productName: 'Product name', farmName: 'Farm name',
    harvestDate: 'Harvest date', currentHolder: 'Current holder',
    issueDate: 'Issue date', expiryDate: 'Expiry date',
    ipfsCid: 'IPFS CID', cid: 'IPFS CID', fileHash: 'SHA-256 file hash',
    certificateNumber: 'Certificate number', role: 'Role', account: 'Wallet address',
    sender: 'Sender wallet', recipient: 'Recipient wallet', from: 'From wallet',
    to: 'To wallet', newOwner: 'New holder', newHolder: 'New holder',
    newStage: 'New stage'
  }
  return known[name] || name.replace(/^_+/, '').replace(/([a-z])([A-Z])/g, '$1 $2').replaceAll('_', ' ').replace(/^./, c => c.toUpperCase())
}

function parseFields(inputs, args, prefix = '') {
  return inputs.flatMap((input, index) => {
    const name = input.name || `Field ${index + 1}`
    const value = args[index]
    if (input.type === 'tuple' && input.components) {
      return parseFields(input.components, value, `${prefix}${name}.`)
    }
    if (input.type.endsWith('[]') && Array.isArray(value)) {
      return [{ label: `${prefix}${prettyName(name)}`, value: readable(value) }]
    }
    let formatted = readable(value)
    if (/date|timestamp/i.test(name) && /^(u?int)/.test(input.type)) {
      const seconds = Number(value)
      if (Number.isFinite(seconds) && seconds > 0 && seconds < 8640000000000) formatted = localTime(seconds)
    }
    return [{ label: `${prefix}${prettyName(name)}`, value: formatted }]
  })
}

function decodeAction(tx, receipt, contractAddress, contractInterface) {
  const action = contractAction(tx, contractAddress, contractInterface)
  let inputFields = []
  let eventFields = []
  let batchId = null
  let product = ''
  let farm = ''
  if (tx.to?.toLowerCase() === contractAddress.toLowerCase()) {
    try {
      const parsed = contractInterface.parseTransaction({ data: tx.data, value: tx.value })
      if (parsed) {
        inputFields = parseFields(parsed.fragment.inputs, parsed.args)
        for (const field of inputFields) {
          if (/^batch id$/i.test(field.label)) batchId = field.value
          if (/^product name$/i.test(field.label)) product = field.value
          if (/^farm name$/i.test(field.label)) farm = field.value
        }
      }
    } catch { /* Unsupported calldata remains visible as a technical transaction. */ }
  }
  for (const log of receipt?.logs || []) {
    if (log.address.toLowerCase() !== contractAddress.toLowerCase()) continue
    try {
      const event = contractInterface.parseLog({ topics: log.topics, data: log.data })
      if (!event) continue
      const fields = parseFields(event.fragment.inputs, event.args)
      eventFields.push({ name: event.name, fields })
      for (const field of fields) {
        if (/^batch id$/i.test(field.label)) batchId = field.value
        if (/^product name$/i.test(field.label) && !product) product = field.value
        if (/^farm name$/i.test(field.label) && !farm) farm = field.value
      }
    } catch { /* The contract may emit an event not present in this ABI. */ }
  }
  const tags = [batchId ? `Batch #${batchId}` : '', product, farm].filter(Boolean)
  if (!tags.length && inputFields.length) {
    const role = inputFields.find(field => field.label === 'Role')
    const wallet = inputFields.find(field => /wallet address|account/i.test(field.label))
    if (role) tags.push(role.value)
    if (wallet) tags.push(shorten(wallet.value, 10, 6))
  }
  return { action, inputFields, eventFields, batchId, summary: tags.join(' · ') }
}

async function loadBatchSnapshot(provider, contractAddress, abi, batchId) {
  if (!batchId || !/^\d+$/.test(batchId)) return null
  try {
    const contract = new Contract(contractAddress, abi, provider)
    const result = await contract.batches(BigInt(batchId))
    if (!result.exists) return null
    return [
      { label: 'Batch ID', value: batchId },
      { label: 'Product name', value: result.productName },
      { label: 'Farm name', value: result.farmName },
      { label: 'Harvest date', value: localTime(result.harvestDate) },
      { label: 'Farmer wallet', value: result.farmer },
      { label: 'Current holder', value: result.currentHolder },
      { label: 'Current stage', value: ['Farmer', 'Distributor', 'Retailer'][Number(result.stage)] || readable(result.stage) }
    ]
  } catch { return null }
}

function FieldRows({ fields }) {
  return <div className="detail-list">{fields.map((field, index) => (
    <div key={`${field.label}-${index}`}><span>{field.label}</span><strong className="break-anywhere">{typeof field.value === 'string' && /^0x[a-fA-F0-9]{40}$/.test(field.value) ? participantDisplay(field.value) : field.value}</strong></div>
  ))}</div>
}

function BlockCard({ block, onInspect }) {
  return (
    <button type="button" className="explorer-block" onClick={() => onInspect(String(block.number))}>
      <span className="explorer-block-symbol" aria-hidden="true">▣</span>
      <span className="explorer-block-info">
        <strong>Block #{block.number}</strong>
        <small>{localTime(block.timestamp)}</small>
      </span>
      <span className="explorer-block-count">{block.transactions.length} tx</span>
      <span className="explorer-block-arrow" aria-hidden="true">→</span>
    </button>
  )
}

function TransactionCard({ transaction, onInspect }) {
  return (
    <button type="button" className="explorer-transaction" onClick={() => onInspect(transaction.hash)}>
      <span className="explorer-tx-main">
        <strong>{transaction.action}</strong>
        <small className="break-anywhere">{transaction.summary || shorten(transaction.hash, 18, 12)}</small><small className="break-anywhere">{shorten(transaction.hash, 14, 9)}</small>
      </span>
      <span className="explorer-tx-meta">
        <span>Block #{transaction.blockNumber}</span>
        <span className={`explorer-tx-status ${transaction.status === 0 ? 'failed' : ''}`}>{transaction.status === 0 ? 'Failed' : transaction.status === 1 ? 'Success' : 'Pending'}</span>
      </span>
    </button>
  )
}

export default function BlockchainExplorer({ abi, contractAddress, initialBatchId = '' }) {
  const provider = useMemo(() => new JsonRpcProvider(PUBLIC_RPC_URL, Number(CHAIN_ID), { staticNetwork: true }), [])
  const contractInterface = useMemo(() => new Interface(abi), [abi])
  const [blocks, setBlocks] = useState([])
  const [transactions, setTransactions] = useState([])
  const [head, setHead] = useState(null)
  const [chainError, setChainError] = useState('')
  const [busy, setBusy] = useState(false)
  const [lookup, setLookup] = useState('')
  const [batchLookup, setBatchLookup] = useState(initialBatchId)
  const [registeredBatches, setRegisteredBatches] = useState([])
  const [batchCount, setBatchCount] = useState(0)
  const [batchListError, setBatchListError] = useState('')
  const [batchListBusy, setBatchListBusy] = useState(false)
  const [batchListLimit, setBatchListLimit] = useState(BATCH_PAGE_SIZE)
  const historyRef = useRef(null)
  const [batchHistory, setBatchHistory] = useState(null)
  const [processingRecord, setProcessingRecord] = useState(null)
  const [processingLoading, setProcessingLoading] = useState(false)
  const [processingError, setProcessingError] = useState('')
  const [batchError, setBatchError] = useState('')
  const [batchBusy, setBatchBusy] = useState(false)
  const [, refreshLabels] = useState(0)
  const [detail, setDetail] = useState(null)
  const [lookupBusy, setLookupBusy] = useState(false)
  const [lookupError, setLookupError] = useState('')
  const [activePanel, setActivePanel] = useState(null)
  const [blockTransactionLimit, setBlockTransactionLimit] = useState(BLOCK_TRANSACTIONS_PAGE_SIZE)

  // nextBatchId supplies the total number of registered batches. Only fetch the
  // current page to avoid issuing thousands of RPC requests for large datasets.
  const loadRegisteredBatches = useCallback(async (limit) => {
    setBatchListBusy(true)
    setBatchListError('')
    try {
      const reader = new Contract(contractAddress, abi, provider)
      if (await provider.getCode(contractAddress) === '0x') throw new Error('Smart contract is not deployed.')
      const next = await reader.nextBatchId()
      const count = next > 1n ? next - 1n : 0n
      setBatchCount(count.toString())
      const items = []
      const end = BigInt(limit) < count ? BigInt(limit) : count
      // Sequential bounded reads avoid overloaded public Sepolia RPCs and keep each
      // page lightweight; an isolated missing record will not hide others.
      for (let i = 1n; i <= end; i++) {
        const result = await reader.batches(i)
        if (!result.exists) continue
        items.push({
          id: i.toString(),
          product: result.productName,
          farm: result.farmName,
          stage: ['Farmer', 'Distributor', 'Retailer'][Number(result.stage)] || 'Unknown',
          holder: result.currentHolder
        })
      }
      setRegisteredBatches(items)
    } catch (err) {
      setBatchListError(err.shortMessage || err.message || 'Cannot load registered batches.')
    } finally { setBatchListBusy(false) }
  }, [abi, contractAddress, provider])

  const refresh = useCallback(async () => {
    setBusy(true)
    setChainError('')
    try {
      const network = await provider.getNetwork()
      if (network.chainId !== CHAIN_ID) throw new Error('This page requires Sepolia (chain ID 11155111).')
      const latest = await provider.getBlockNumber()
      const numbers = Array.from({ length: Math.min(latest + 1, RECENT_BLOCKS) }, (_, index) => latest - index)
      const loaded = (await Promise.all(numbers.map(number => provider.getBlock(number)))).filter(Boolean)
      const txHashes = loaded.flatMap(block => block.transactions).slice(0, MAX_RECENT_TRANSACTIONS)
      const recent = await Promise.all(txHashes.map(async hash => {
        const [tx, receipt] = await Promise.all([provider.getTransaction(hash), provider.getTransactionReceipt(hash)])
        if (!tx) return null
        return {
          hash: tx.hash,
          blockNumber: tx.blockNumber,
          ...decodeAction(tx, receipt, contractAddress, contractInterface),
          status: receipt?.status ?? null
        }
      }))
      setHead(latest)
      setBlocks(loaded)
      setTransactions(recent.filter(Boolean))
      await loadRegisteredBatches(batchListLimit)
    } catch (err) {
      console.error('Blockchain explorer could not load:', err)
      setChainError(`${err.shortMessage || err.message || 'Blockchain connection failed.'} Check your Sepolia RPC endpoint.`)
    } finally {
      setBusy(false)
    }
  }, [provider, contractAddress, contractInterface, loadRegisteredBatches, batchListLimit])

  useEffect(() => {
    loadParticipantNames().catch(err => console.warn('MongoDB names unavailable:', err.message))
    const listener = () => refreshLabels(v => v + 1)
    window.addEventListener(PARTICIPANTS_UPDATED, listener)
    window.addEventListener('storage', listener)
    return () => { window.removeEventListener(PARTICIPANTS_UPDATED, listener); window.removeEventListener('storage', listener) }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  async function loadHistory(rawId) {
    const value = String(rawId).trim()
    setBatchLookup(value)
    setBatchHistory(null)
    setBatchError('')
    if (!/^[1-9]\d*$/.test(value)) { setBatchError('Enter a positive batch ID.'); return }
    setBatchBusy(true)
    try {
      const chain = await provider.getNetwork()
      if (chain.chainId !== CHAIN_ID) throw new Error('Wrong blockchain network.')
      const reader = new Contract(contractAddress, abi, provider)
      const code = await provider.getCode(contractAddress)
      if (code === '0x') throw new Error('Smart contract was not found on Sepolia.')
      const batch = await reader.batches(BigInt(value))
      if (!batch.exists) throw new Error(`Batch #${value} does not exist.`)
      const current = await loadBatchSnapshot(provider, contractAddress, abi, value)
      // Look up batch-indexed event logs. The helper combines actual RPC and
      // explorer logs; the old full-chain scan overloaded public Sepolia RPCs.
      const events = await getBatchEvents(contractInterface, value, contractAddress)
      const found = events.map(event => ({
        hash: event.transactionHash,
        blockNumber: event.blockNumber,
        logIndex: event.index,
        eventName: event.name
      }))
      // One row per actual transaction, even if multiple matching events were emitted.
      const unique = [...new Map(found.map(item => [item.hash, item])).values()]
        .sort((a,b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex)
      const history = await Promise.all(unique.map(async item => {
        const [tx, receipt, block] = await Promise.all([
          provider.getTransaction(item.hash), provider.getTransactionReceipt(item.hash), provider.getBlock(item.blockNumber)
        ])
        if (!tx) return null
        return {...item, ...decodeAction(tx, receipt, contractAddress, contractInterface),
          timestamp: block?.timestamp, status: receipt?.status, gasUsed: receipt?.gasUsed?.toString() || '—'}
      }))
      setBatchHistory({id:value, snapshot:current, transactions:history.filter(Boolean)})
    } catch (err) {
      console.error('Batch history failed:',err)
      setBatchError(err.shortMessage || err.message || 'Could not load history.')
    } finally { setBatchBusy(false) }
  }

  useEffect(() => {
    let active = true
    setProcessingRecord(null)
    setProcessingError('')
    setProcessingLoading(false)
    if (!batchHistory?.id || !processingConfigured) return () => { active = false }
    setProcessingLoading(true)
    loadProcessing(batchHistory.id)
      .then(data => { if (active) setProcessingRecord(data) })
      .catch(err => { if (active) setProcessingError(err.message) })
      .finally(() => { if (active) setProcessingLoading(false) })
    return () => { active = false }
  }, [batchHistory?.id])

  useEffect(() => {
    if (batchHistory && historyRef.current) {
      historyRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }, [batchHistory])

  useEffect(() => {
    if (initialBatchId) loadHistory(initialBatchId)
    // The parent changes initialBatchId only when opening a specific batch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialBatchId])

  async function inspect(rawValue) {
    const value = String(rawValue).trim()
    setLookup(value)
    setLookupBusy(true)
    setLookupError('')
    setDetail(null)
    setBlockTransactionLimit(BLOCK_TRANSACTIONS_PAGE_SIZE)
    try {
      if (/^\d+$/.test(value)) {
        const number = Number(value)
        if (!Number.isSafeInteger(number)) throw new Error('Block number is too large.')
        const block = await provider.getBlock(number)
        if (!block) throw new Error(`Block #${value} was not found.`)
        setDetail({ kind: 'block', block })
      } else if (/^0x[a-fA-F0-9]{64}$/.test(value)) {
        const [tx, receipt] = await Promise.all([provider.getTransaction(value), provider.getTransactionReceipt(value)])
        if (!tx) throw new Error('Transaction hash was not found on this blockchain.')
        const block = tx.blockNumber == null ? null : await provider.getBlock(tx.blockNumber)
        const decoded = decodeAction(tx, receipt, contractAddress, contractInterface)
        const snapshot = await loadBatchSnapshot(provider, contractAddress, abi, decoded.batchId)
        setDetail({ kind: 'transaction', tx, receipt, block, ...decoded, snapshot })
      } else {
        throw new Error('Enter a block number or a complete 0x transaction hash (66 characters).')
      }
    } catch (err) {
      setLookupError(err.shortMessage || err.message || 'Could not load details.')
    } finally {
      setLookupBusy(false)
    }
  }

  function handleSearch(event) {
    event.preventDefault()
    inspect(lookup)
  }

  const combinedTimeline = batchHistory ? [
    ...batchHistory.transactions.map(tx => ({ kind: 'transaction', blockNumber: Number(tx.blockNumber), logIndex: Number(tx.logIndex || 0), tx })),
    ...(processingRecord?.exists ? [{ kind: 'processing', blockNumber: Number(processingRecord.block), logIndex: 0, record: processingRecord }] : [])
  ].sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex) : []

  return (
    <div className="explorer-page">
      <section className="explorer-banner">
        <div>
          <span className="step-tag">LIVE SEPOLIA BLOCKCHAIN</span>
          <h2>Explore your blockchain</h2>
          <p>Inspect real blocks, transactions and smart contract activity. This page reads Sepolia through a public RPC — no MetaMask or transaction signing required.</p>
        </div>
        <button type="button" className="button-outline explorer-refresh" onClick={refresh} disabled={busy}>{busy ? 'Loading…' : '↻ Refresh data'}</button>
      </section>

      {chainError && <div className="notice consumer-error" role="alert"><span className="notice-symbol">!</span><div><strong>Cannot read Sepolia</strong><p>{chainError}</p></div></div>}

      <div className="explorer-stats">
        <div className="explorer-stat"><span>Latest block</span><strong>{head === null ? '—' : `#${head}`}</strong></div>
        <div className="explorer-stat"><span>Blocks displayed</span><strong>{blocks.length}</strong></div>
        <div className="explorer-stat"><span>Recent transactions displayed</span><strong>{transactions.length}</strong></div>
        <div className="explorer-stat"><span>Network</span><strong>Sepolia · 11155111</strong></div>
      </div>

      <section className="form-card explorer-search-card">
        <h2>Find a block or transaction</h2>
        <p className="card-description">Enter a block number (such as 1) or paste a complete transaction hash.</p>
        <form className="explorer-search-form" onSubmit={handleSearch}>
          <label className="field"><span>Block number / transaction hash</span><input type="text" value={lookup} onChange={event => setLookup(event.target.value)} placeholder="e.g. 5 or 0x..." required /></label>
          <button type="submit" className="button-primary" disabled={lookupBusy}>{lookupBusy ? 'Searching…' : 'Inspect →'}</button>
        </form>
        {lookupError && <p className="error-message explorer-inline-error" role="alert">{lookupError}</p>}
      </section>

      {detail && <section className="result-card explorer-detail" aria-live="polite">
        <div className="card-topline"><span className="step-tag">{detail.kind === 'block' ? 'BLOCK DETAILS' : 'TRANSACTION DETAILS'}</span><button type="button" className="qr-small-button" onClick={() => setDetail(null)}>Close</button></div>
        {detail.kind === 'block' ? <>
          <h2>Block #{detail.block.number}</h2>
          <div className="detail-list">
            <div><span>Block hash</span><strong className="break-anywhere">{detail.block.hash}</strong></div>
            <div><span>Previous block hash</span><strong className="break-anywhere">{detail.block.parentHash}</strong></div>
            <div><span>Timestamp</span><strong>{localTime(detail.block.timestamp)}</strong></div>
            <div><span>Transactions</span><strong>{detail.block.transactions.length}</strong></div>
            <div><span>Gas used</span><strong>{detail.block.gasUsed.toString()}</strong></div>
            <div><span>Gas limit</span><strong>{detail.block.gasLimit.toString()}</strong></div>
          </div>
          {detail.block.transactions.length > 0 && <div className="explorer-block-transactions">
            <h3>Transactions in this block</h3>
            <p className="card-description">Showing {Math.min(blockTransactionLimit, detail.block.transactions.length)} of {detail.block.transactions.length} transactions</p>
            {detail.block.transactions.slice(0, blockTransactionLimit).map(hash =>
              <button type="button" className="explorer-hash-link break-anywhere" key={hash} onClick={() => inspect(hash)}>{hash} →</button>
            )}
            {blockTransactionLimit < detail.block.transactions.length &&
              <button type="button" className="button-outline explorer-load-more" onClick={() => setBlockTransactionLimit(v => v + BLOCK_TRANSACTIONS_PAGE_SIZE)}>
                Show 10 more transactions
              </button>}
          </div>}
        </> : <>
          <h2>{detail.action}</h2>
          {detail.summary && <p className="explorer-meaningful-summary">{detail.summary}</p>}
          
          {detail.inputFields.length > 0 && <div className="explorer-context-section"><h3>Recorded transaction information</h3><FieldRows fields={detail.inputFields} /></div>}
          {detail.eventFields.map((event, index) => <div className="explorer-context-section" key={`${event.name}-${index}`}><h3>Blockchain event: {event.name}</h3><FieldRows fields={event.fields} /></div>)}
          {detail.batchId && <button type="button" className="button-outline" onClick={() => loadHistory(detail.batchId)}>Show Batch #{detail.batchId} journey ↓</button>}
          {detail.snapshot && <details className="explorer-context-section">
            <summary style={{ cursor: 'pointer', fontWeight: 700, padding: '8px 0' }}>View current batch state</summary>
            <FieldRows fields={detail.snapshot} />
          </details>}
          <details className="explorer-context-section">
            <summary style={{ cursor: 'pointer', fontWeight: 700, padding: '8px 0' }}>Technical transaction details</summary>
          <div className="detail-list">
            <div><span>Transaction hash</span><strong className="break-anywhere">{detail.tx.hash}</strong></div>
            <div><span>Status</span><strong>{detail.receipt?.status === 1 ? 'Success' : detail.receipt?.status === 0 ? 'Failed' : 'Pending'}</strong></div>
            <div><span>Block number</span><strong>{detail.tx.blockNumber ?? 'Pending'}</strong></div>
            <div><span>Timestamp</span><strong>{localTime(detail.block?.timestamp)}</strong></div>
            <div><span>From wallet</span><strong className="break-anywhere">{participantDisplay(detail.tx.from)}</strong></div>
            <div><span>To address</span><strong className="break-anywhere">{detail.tx.to ? participantDisplay(detail.tx.to) : `Contract creation${detail.receipt?.contractAddress ? `: ${detail.receipt.contractAddress}` : ''}`}</strong></div>
            <div><span>Value (ETH)</span><strong>{formatEther(detail.tx.value)}</strong></div>
            <div><span>Gas used</span><strong>{detail.receipt ? detail.receipt.gasUsed.toString() : 'Pending'}</strong></div>
            <div><span>Transaction fee (ETH)</span><strong>{detail.receipt ? formatEther(detail.receipt.gasUsed * detail.receipt.gasPrice) : 'Pending'}</strong></div>
            <div><span>Nonce</span><strong>{detail.tx.nonce}</strong></div>
          </div></details>
        </>}
      </section>}

      <div className="ot-explorer-cards" aria-label="Choose blockchain information">
        <button type="button" className={`ot-explorer-nav-card ${activePanel === 'blocks' ? 'is-active' : ''}`}
          aria-expanded={activePanel === 'blocks'} aria-controls="ot-blocks-panel"
          onClick={() => setActivePanel(current => current === 'blocks' ? null : 'blocks')}>
          <span className="ot-explorer-card-icon" aria-hidden="true">▣</span>
          <span className="ot-explorer-card-kicker">BLOCKCHAIN HISTORY</span>
          <strong>Blocks</strong>
          <span className="ot-explorer-card-description">Explore the latest Sepolia blocks and inspect their transactions.</span>
          <span className="ot-explorer-card-footer"><span>{blocks.length} recent blocks</span><span aria-hidden="true">{activePanel === 'blocks' ? '−' : '→'}</span></span>
        </button>
        <button type="button" className={`ot-explorer-nav-card ${activePanel === 'transactions' ? 'is-active' : ''}`}
          aria-expanded={activePanel === 'transactions'} aria-controls="ot-transactions-panel"
          onClick={() => setActivePanel(current => current === 'transactions' ? null : 'transactions')}>
          <span className="ot-explorer-card-icon" aria-hidden="true">⇄</span>
          <span className="ot-explorer-card-kicker">TRANSACTION ACTIVITY</span>
          <strong>Transactions</strong>
          <span className="ot-explorer-card-description">Review recent blockchain transactions and inspect their details.</span>
          <span className="ot-explorer-card-footer"><span>{transactions.length} recent transactions</span><span aria-hidden="true">{activePanel === 'transactions' ? '−' : '→'}</span></span>
        </button>
        <button type="button" className={`ot-explorer-nav-card ${activePanel === 'batches' ? 'is-active' : ''}`}
          aria-expanded={activePanel === 'batches'} aria-controls="ot-batches-panel"
          onClick={() => setActivePanel(current => current === 'batches' ? null : 'batches')}>
          <span className="ot-explorer-card-icon" aria-hidden="true">▤</span>
          <span className="ot-explorer-card-kicker">PRODUCT TRACEABILITY</span>
          <strong>Food batches</strong>
          <span className="ot-explorer-card-description">Select a registered food batch to inspect its verified journey.</span>
          <span className="ot-explorer-card-footer"><span>{batchCount} registered batches</span><span aria-hidden="true">{activePanel === 'batches' ? '−' : '→'}</span></span>
        </button>
      </div>

      {activePanel && <section className="form-card ot-explorer-panel" id={`ot-${activePanel}-panel`} aria-label={`${activePanel} details`}>
        <div className="ot-explorer-panel-heading">
          <div><span className="step-tag">{activePanel === 'blocks' ? 'BLOCKCHAIN HISTORY' : activePanel === 'transactions' ? 'TRANSACTION ACTIVITY' : 'PRODUCT TRACEABILITY'}</span>
          <h2>{activePanel === 'blocks' ? 'Latest blocks' : activePanel === 'transactions' ? 'Recent transactions' : 'Registered food batches'}</h2></div>
          <button type="button" className="qr-small-button" onClick={() => setActivePanel(null)}>Close</button>
        </div>
        {activePanel === 'blocks' && <div className="ot-explorer-panel-list">
          {blocks.length ? blocks.map(block => <BlockCard key={block.hash} block={block} onInspect={inspect} />) : <p className="explorer-empty">{busy ? 'Loading blocks…' : 'No blocks available.'}</p>}
        </div>}
        {activePanel === 'transactions' && <div className="ot-explorer-panel-list">
          {transactions.length ? transactions.map(tx => <TransactionCard key={tx.hash} transaction={tx} onInspect={inspect} />) : <p className="explorer-empty">{busy ? 'Loading transactions…' : 'No transactions in the displayed blocks.'}</p>}
        </div>}
        {activePanel === 'batches' && <>
          
          {batchListError && <p role="alert" className="error-message explorer-inline-error">{batchListError}</p>}
          <div className="ot-explorer-panel-list">
            {registeredBatches.map(batch => (
              <button type="button" key={batch.id}
                className={`explorer-batch-row ${batchHistory?.id === batch.id ? 'selected' : ''}`}
                onClick={() => loadHistory(batch.id)} disabled={batchBusy}>
                <span className="explorer-block-symbol" aria-hidden="true">▤</span>
                <span className="explorer-block-info">
                  <strong>Batch #{batch.id} · {batch.product}</strong>
                  <small>{batch.farm} · {batch.stage}</small>
                </span>
                <span className="explorer-block-arrow" aria-hidden="true">→</span>
              </button>
            ))}
            {!registeredBatches.length && !batchListError && <p className="explorer-empty">{batchListBusy ? 'Loading registered batches…' : 'No food batches registered yet.'}</p>}
          </div>
          {BigInt(batchCount) > BigInt(batchListLimit) && <button type="button" className="button-outline explorer-load-more"
            disabled={batchListBusy} onClick={() => setBatchListLimit(v => v + BATCH_PAGE_SIZE)}>
            {batchListBusy ? 'Loading…' : `Load more batches (${registeredBatches.length} of ${batchCount})`}
          </button>}
        </>}
      </section>}
      {(batchHistory || batchBusy || batchError) && <section className="result-card explorer-batch-journey" ref={historyRef} aria-live="polite">
        <div className="card-topline"><span className="step-tag">FOOD BATCH · COMPLETE BLOCKCHAIN HISTORY</span>
          <button type="button" className="qr-small-button" onClick={() => { setBatchHistory(null); setBatchError('') }}>Close</button>
        </div>
        <h2>Batch #{batchLookup} — Product journey</h2>
        {batchBusy && <p className="card-description">Reading transaction events from the blockchain…</p>}
        {batchError && <p className="error-message" role="alert">{batchError}</p>}
        {batchHistory && <>

          {!processingConfigured && <p className="consumer-warning">Processing contract is not configured in this build (VITE_PROCESSING_CONTRACT_ADDRESS).</p>}
          {processingError && <p className="consumer-warning" role="status">Processing record unavailable: {processingError}</p>}
          {processingLoading && <p className="card-description">Checking the Processing contract…</p>}
          <h3 className="explorer-journey-heading">Recorded stages and actions</h3>
          {combinedTimeline.length ? <ol className="timeline batch-chain-timeline">
            {combinedTimeline.map((entry, index) => entry.kind === 'processing' ? <li className="timeline-event" key={`processing-${batchHistory.id}`}><span className="timeline-dot" aria-hidden="true" /><div className="explorer-journey-event"><div className="explorer-journey-event-header"><strong>{index + 1}. Processing completed</strong><span className="mini-tag">Block #{entry.blockNumber}</span></div><div className="detail-list"><div><span>Quantity received</span><strong>{entry.record.quantityKg} kg</strong></div><div><span>Processing method</span><strong>{entry.record.method}</strong></div><div><span>Processing date</span><strong>{new Date(entry.record.date * 1000).toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' })}</strong></div><div><span>Processor</span><strong>{participantDisplay(entry.record.processor)}</strong></div></div><a className="external-link" href={`https://sepolia.etherscan.io/address/${PROCESSING_ADDRESS}`} target="_blank" rel="noreferrer">View processing record ↗</a></div></li> : (() => { const tx = entry.tx; return <li className="timeline-event" key={tx.hash}>
              <span className="timeline-dot" aria-hidden="true" />
              <div className="explorer-journey-event">
                <div className="explorer-journey-event-header"><strong>{index + 1}. {tx.action}</strong><span className="mini-tag">Block #{tx.blockNumber}</span></div>
                <small>{localTime(tx.timestamp)} · {tx.status === 1 ? 'Successful' : tx.status === 0 ? 'Failed' : 'Pending'} · Gas {tx.gasUsed}</small>
                {tx.inputFields.length > 0 && <FieldRows fields={tx.inputFields} />}
                {tx.eventFields.map((event, eventIndex) => <div key={`${event.name}-${eventIndex}`} className="explorer-journey-event-fields">
                  <strong className="explorer-event-name">{event.name}</strong><FieldRows fields={event.fields} />
                </div>)}
                <button type="button" className="explorer-hash-link break-anywhere" onClick={() => { inspect(tx.hash); window.scrollTo({ top: 0, behavior: 'smooth' }) }}>
                  Inspect transaction {shorten(tx.hash, 17, 10)} →
                </button>
              </div>
            </li> })())}
          </ol> : <p className="explorer-empty">No verified history entries were found for this batch. The current batch record is shown above.</p>}
        </>}
      </section>}
    </div>
  )
}
