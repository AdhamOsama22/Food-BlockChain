/** OrganicTrace: verified Sepolia batch history.
 * Reads indexed Blockscout event logs; when needed, confirms individual
 * contract transactions using Alchemy transaction receipts.
 * Never calls eth_getLogs across large historical block ranges.
 * No invented events, and no blockchain writes.
 */
import { JsonRpcProvider } from 'ethers'
import { PUBLIC_RPC_URL, CHAIN_ID, CONTRACT_ADDRESS } from './sepoliaConfig.js'

const BLOCKSCOUT = 'https://eth-sepolia.blockscout.com/api/v2'
const DEPLOYMENT_BLOCK = 12135770
const EVENT_NAMES = new Set([
  'BatchRegistered', 'BatchTransferred',
  'CertificateRegistered', 'CertificateRevoked'
])
const HEX_HASH = /^0x[\da-f]{64}$/i

function integer(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : NaN
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'string' && (/^\d+$/.test(value) || /^0x[\da-f]+$/i.test(value))) {
    return Number(BigInt(value))
  }
  return NaN
}

/** Accept both ethers receipt logs and Blockscout's API-v2 log structure. */
function decodeEvent(raw, iface, batchId) {
  try {
    const address = raw.address?.hash ?? raw.address ?? raw.smart_contract?.hash
    if (String(address).toLowerCase() !== CONTRACT_ADDRESS.toLowerCase()) return null

    const topics = (raw.topics || []).map(topic =>
      typeof topic === 'string' ? topic : topic?.hex ?? topic?.value
    )
    if (!topics.length || topics.some(topic => !HEX_HASH.test(String(topic)))) return null

    const parsed = iface.parseLog({ topics, data: raw.data || '0x' })
    if (!parsed || !EVENT_NAMES.has(parsed.name)) return null
    const idIndex = parsed.fragment.inputs.findIndex(field => field.name === 'batchId')
    if (idIndex < 0 || BigInt(parsed.args[idIndex]) !== BigInt(batchId)) return null

    const transactionHash = raw.transactionHash ?? raw.transaction_hash
    const blockNumber = integer(raw.blockNumber ?? raw.block_number)
    const index = integer(raw.logIndex ?? raw.log_index ?? raw.index ?? 0)
    if (!HEX_HASH.test(String(transactionHash)) ||
        !Number.isSafeInteger(blockNumber) || blockNumber < DEPLOYMENT_BLOCK ||
        !Number.isSafeInteger(index) || index < 0) return null

    return {
      name: parsed.name,
      blockNumber,
      index,
      transactionHash,
      wallets: parsed.fragment.inputs.flatMap((field, i) =>
        field.type === 'address' ? [String(parsed.args[i])] : []
      )
    }
  } catch {
    return null
  }
}

async function readJSON(url) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15000)
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: controller.signal
    })
    if (!response.ok) throw new Error(`Blockscout returned HTTP ${response.status}`)
    const result = await response.json()
    if (!Array.isArray(result.items)) throw new Error('Unexpected Blockscout API response')
    return result
  } finally {
    clearTimeout(timeout)
  }
}

/** Fetch every page, otherwise older registration events can be omitted. */
async function readPages(path, maxItems = 500) {
  let cursor = null
  const visited = new Set()
  const items = []
  for (let page = 0; page < 30; page++) {
    const url = new URL(`${BLOCKSCOUT}${path}`)
    if (cursor) {
      for (const [key, value] of Object.entries(cursor)) {
        if (value != null) url.searchParams.set(key, String(value))
      }
    }
    if (visited.has(url.href)) throw new Error('Repeated Blockscout pagination cursor')
    visited.add(url.href)

    const result = await readJSON(url.href)
    items.push(...result.items)
    if (items.length > maxItems) throw new Error('History exceeds indexed lookup limit')
    if (!result.next_page_params) return items
    cursor = result.next_page_params
  }
  throw new Error('Blockscout pagination did not finish')
}

function ordered(events) {
  return [...events.values()].sort((a, b) =>
    a.blockNumber - b.blockNumber || a.index - b.index
  )
}

function collect(map, logs, iface, id) {
  for (const raw of logs) {
    const item = decodeEvent(raw, iface, id)
    if (item) map.set(`${item.transactionHash.toLowerCase()}:${item.index}`, item)
  }
}

/**
 * Blockscout indexes the entire contract history, unlike limited-range
 * eth_getLogs calls. The fallback uses eth_getTransactionReceipt only for
 * actual indexed contract transactions (no thousands-of-blocks scan).
 */
export async function getBatchEvents(iface, batchId, contract = CONTRACT_ADDRESS) {
  const id = String(batchId).trim()
  if (!/^[1-9]\d*$/.test(id)) throw new Error('Invalid batch ID')
  if (String(contract).toLowerCase() !== CONTRACT_ADDRESS.toLowerCase()) {
    throw new Error('Unexpected contract address')
  }

  const found = new Map()
  const errors = []
  let indexedLogsComplete = false

  try {
    const logs = await readPages(`/addresses/${CONTRACT_ADDRESS}/logs`)
    collect(found, logs, iface, id)
    indexedLogsComplete = true
  } catch (error) {
    errors.push(`Explorer logs: ${error.message}`)
  }

  // Complete indexed logs already include the original registration event.
  // Do not needlessly request individual receipts in that case.
  if (indexedLogsComplete && ordered(found).some(e => e.name === 'BatchRegistered')) {
    return ordered(found)
  }

  // Find actual transaction hashes sent to this contract; never infer an
  // event from the current contract state or from the batch counter.
  let transactions
  try {
    transactions = await readPages(
      `/addresses/${CONTRACT_ADDRESS}/transactions?filter=to`, 500
    )
  } catch (error) {
    errors.push(`Explorer transactions: ${error.message}`)
    if (found.size) return ordered(found)
    throw new Error(`Cannot retrieve batch events. ${errors.join(' | ')}`)
  }

  const candidates = []
  for (const tx of transactions) {
    const to = tx.to?.hash ?? tx.to
    if (String(to || '').toLowerCase() !== CONTRACT_ADDRESS.toLowerCase()) continue
    if (!HEX_HASH.test(String(tx.hash))) continue
    if (tx.status === 'error' || tx.status === 'failed' || tx.status === 'reverted') continue

    // When calldata is provided, ignore unrelated contract calls. Registration
    // does not contain the ID as an input: read its emitted receipt to match.
    const calldata = tx.raw_input || tx.input
    if (typeof calldata === 'string' && calldata.startsWith('0x')) {
      try {
        const call = iface.parseTransaction({ data: calldata })
        if (call) {
          if (!['registerBatch', 'transferBatch', 'registerCertificate', 'revokeCertificate'].includes(call.name)) continue
          if (call.name !== 'registerBatch' && BigInt(call.args[0]) !== BigInt(id)) continue
        }
      } catch { /* Confirm through event logs in the receipt instead. */ }
    }
    candidates.push(tx.hash)
  }

  if (candidates.length > 500) throw new Error('Too many transactions to verify safely')
  const provider = new JsonRpcProvider(PUBLIC_RPC_URL, Number(CHAIN_ID), { staticNetwork: true })
  let successfulReads = 0
  // Small concurrency limits keep free-tier Alchemy calls predictable.
  for (let start = 0; start < candidates.length; start += 4) {
    const part = candidates.slice(start, start + 4)
    const results = await Promise.allSettled(part.map(hash => provider.getTransactionReceipt(hash)))
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        successfulReads++
        if (result.value.status === 1) collect(found, result.value.logs, iface, id)
      } else if (result.status === 'rejected') {
        errors.push(`Transaction receipt: ${result.reason?.shortMessage || result.reason?.message || 'unavailable'}`)
      }
    }
  }

  if (found.size) return ordered(found)
  if (indexedLogsComplete && successfulReads === candidates.length) return []
  throw new Error(`Cannot verify batch history completely. ${errors.slice(0, 4).join(' | ') || 'Indexed events unavailable'}`)
}
