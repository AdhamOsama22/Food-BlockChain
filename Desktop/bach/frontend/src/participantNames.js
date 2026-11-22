/** Public names come from MongoDB via the Express API, not browser localStorage. */
import { BrowserProvider } from 'ethers'
import { CHAIN_ID } from './sepoliaConfig.js'

const API = `${(import.meta.env.VITE_API_BASE_URL || (import.meta.env.PROD ? '' : 'http://127.0.0.1:3001')).replace(/\/$/, '')}/api`
export const PARTICIPANTS_UPDATED = 'organictrace:participants-updated'
let cache = Object.create(null)

export function participantName(address) {
  if (typeof address !== 'string') return ''
  return cache[address.toLowerCase()] || ''
}
export function walletDisplay(address) {
  const label = participantName(address)
  return label ? `${label} (MongoDB label) · ${address}` : address
}
export async function loadParticipantNames() {
  const res = await fetch(`${API}/participants`, { cache: 'no-store' })
  const payload = await res.json()
  if (!res.ok) throw new Error(payload.error || 'Cannot load participant names.')
  const next = Object.create(null)
  for (const item of payload.participants || []) {
    if (typeof item.walletAddress === 'string' && typeof item.name === 'string') {
      next[item.walletAddress.toLowerCase()] = item.name
    }
  }
  cache = next
  window.dispatchEvent(new Event(PARTICIPANTS_UPDATED))
  return next
}

/** Admin signs a one-use challenge; the server must verify the admin role on Sepolia. */
export async function saveParticipantName(address, name) {
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) throw new Error('Enter a valid wallet address.')
  const cleaned = String(name || '').trim().replace(/\s+/g, ' ')
  if (!cleaned || cleaned.length > 100) throw new Error('Name must be 1–100 characters.')
  if (!window.ethereum) throw new Error('Connect MetaMask with the administrator wallet.')
  const provider = new BrowserProvider(window.ethereum)
  const network = await provider.getNetwork()
  if (network.chainId !== CHAIN_ID) throw new Error('Select Sepolia (11155111).')
  const signer = await provider.getSigner()
  const adminAddress = await signer.getAddress()
  const challengeResponse = await fetch(`${API}/participants/challenge`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ adminAddress, walletAddress: address, name: cleaned })
  })
  const challenge = await challengeResponse.json()
  if (!challengeResponse.ok) throw new Error(challenge.error || 'Admin authorization failed.')
  const signature = await signer.signMessage(challenge.message)
  const response = await fetch(`${API}/participants`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ walletAddress: address, name: cleaned, nonce: challenge.nonce, signature })
  })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error || 'Participant name was not saved.')
  await loadParticipantNames()
  return result.participant
}
