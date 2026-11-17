/** Confirmed OrganicTrace events, sourced from Sepolia blockchain logs.
 * Blockscout's indexed API avoids eth_getLogs restrictions on public JSON-RPC nodes.
 * RPC is a fallback; neither source fabricates transfer stages.
 */
import { JsonRpcProvider } from 'ethers'
import { CHAIN_ID, PUBLIC_RPC_URL, CONTRACT_ADDRESS, getEventStartBlock } from './sepoliaConfig'

const EXPLORER = 'https://eth-sepolia.blockscout.com'
const RPC_URLS = [...new Set([PUBLIC_RPC_URL, 'https://ethereum-sepolia-rpc.publicnode.com', 'https://sepolia.drpc.org'])]

const timeoutFetch = async (url) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 12000)
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } })
    if (!response.ok) throw new Error(`Explorer HTTP ${response.status}`)
    return await response.json()
  } finally { clearTimeout(timer) }
}

function parseEvent(raw, iface, contractAddress, batchId) {
  if (String(raw.address || '').toLowerCase() !== contractAddress.toLowerCase()) return null
  try {
    const parsed = iface.parseLog({ topics: raw.topics, data: raw.data })
    if (!parsed || !['BatchRegistered', 'BatchTransferred', 'CertificateRegistered', 'CertificateRevoked'].includes(parsed.name)) return null
    const position = parsed.fragment.inputs.findIndex(x => /batch.*id/i.test(x.name || '') && x.type.startsWith('uint'))
    if (position < 0 || parsed.args[position].toString() !== String(batchId)) return null
    return {
      name: parsed.name,
      blockNumber: Number(raw.blockNumber ?? raw.block_number),
      index: Number(raw.index ?? 0),
      transactionHash: raw.transactionHash ?? raw.transaction_hash,
      wallets: parsed.fragment.inputs.flatMap((x, i) => x.type === 'address' ? [parsed.args[i]] : []),
      args: parsed.args
    }
  } catch { return null }
}

async function fromBlockscout(iface, contractAddress, batchId) {
  const results = []
  let params = null
  const seenPages = new Set()
  for (let page = 0; page < 50; page++) {
    const url = new URL(`${EXPLORER}/api/v2/addresses/${contractAddress}/logs`)
    if (params) Object.entries(params).forEach(([k, v]) => { if (v != null) url.searchParams.set(k, String(v)) })
    const pageKey = url.toString()
    if (seenPages.has(pageKey)) throw new Error('Explorer repeated an event page')
    seenPages.add(pageKey)
    const response = await timeoutFetch(pageKey)
    if (!Array.isArray(response.items)) throw new Error('Unexpected explorer response')
    for (const log of response.items) {
      const event = parseEvent({ ...log, address: log.address?.hash || log.address }, iface, contractAddress, batchId)
      if (event) results.push(event)
    }
    if (!response.next_page_params) return results
    params = response.next_page_params
  }
  throw new Error('Event history has more than 50 pages; cannot confirm complete history')
}

async function fromRpc(iface, contractAddress, batchId, provider) {
  const start = await getEventStartBlock(provider)
  const tip = await provider.getBlockNumber()
  const topics = ['BatchRegistered', 'BatchTransferred', 'CertificateRegistered', 'CertificateRevoked']
    .map(name => iface.getEvent(name)?.topicHash).filter(Boolean)
  const batchTopic = '0x' + BigInt(batchId).toString(16).padStart(64, '0')
  const results = []
  for (let cursor = start; cursor <= tip;) {
    const end = Math.min(tip, cursor + 499)
    const logs = await provider.getLogs({ address: contractAddress, fromBlock: cursor, toBlock: end, topics: [topics, batchTopic] })
    for (const log of logs) {
      const event = parseEvent(log, iface, contractAddress, batchId)
      if (event) results.push(event)
    }
    cursor = end + 1
  }
  return results
}

// Blockscout can return an incomplete set of old logs despite returning a valid response.
// When transfers exist but BatchRegistered is absent, attempt a targeted, indexed
// on-chain log lookup before concluding that registration was not indexed.
async function backfillRegistration(events, iface, contractAddress, batchId) {
  if (events.some(item => item.name === 'BatchRegistered')) return events
  const registrationTopic = iface.getEvent('BatchRegistered')?.topicHash
  if (!registrationTopic) return events
  const batchTopic = '0x' + BigInt(batchId).toString(16).padStart(64, '0')
  const deploymentBlock = 12135770 // Existing OrganicTrace deployment on Sepolia
  for (const url of RPC_URLS) {
    const provider = new JsonRpcProvider(url, Number(CHAIN_ID), { staticNetwork: true })
    try {
      const tip = await provider.getBlockNumber()
      // The registered batch must have been created after this contract's deployment.
      for (let start = deploymentBlock; start <= tip; start += 1500) {
        const end = Math.min(tip, start + 1499)
        const logs = await provider.getLogs({
          address: contractAddress, fromBlock: start, toBlock: end,
          topics: [registrationTopic, batchTopic]
        })
        const parsed = logs.map(log => parseEvent(log, iface, contractAddress, batchId)).filter(Boolean)
        if (parsed.length) {
          const known = new Set(events.map(item => `${item.transactionHash}:${item.index}`))
          return [...events, ...parsed.filter(item => !known.has(`${item.transactionHash}:${item.index}`))]
        }
      }
    } catch (error) {
      console.warn('Registration event backfill unavailable:', error.message)
    } finally { provider.destroy() }
  }
  return events
}

/** Returns only chain-emitted, batch-matched events in chronological order. */
export async function getBatchEvents(iface, batchId, contractAddress = CONTRACT_ADDRESS) {
  if (!/^[1-9]\d*$/.test(String(batchId))) throw new Error('Invalid batch ID')
  const failures = []
  try {
    const events = await fromBlockscout(iface, contractAddress, batchId)
    return (await backfillRegistration(events, iface, contractAddress, batchId)).sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index)
  } catch (error) { failures.push(`Explorer: ${error.message}`) }
  for (const url of RPC_URLS) {
    const provider = new JsonRpcProvider(url, Number(CHAIN_ID), { staticNetwork: true })
    try {
      const events = await fromRpc(iface, contractAddress, batchId, provider)
      return (await backfillRegistration(events, iface, contractAddress, batchId)).sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index)
    } catch (error) { failures.push(`RPC: ${error.message}`) }
    finally { provider.destroy() }
  }
  throw new Error(`Could not retrieve confirmed blockchain events. ${failures.join(' | ')}`)
}
