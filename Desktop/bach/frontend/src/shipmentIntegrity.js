/** Browser utilities: same JSON bytes are SHA-256 hashed for write and read. */
import { BrowserProvider, Contract, JsonRpcProvider, sha256, toUtf8Bytes, isAddress } from 'ethers'
import { PUBLIC_RPC_URL, CHAIN_ID, CONTRACT_ADDRESS } from './sepoliaConfig.js'
import { canonicalShipment } from './shipmentCanonical.mjs'

export const SHIPMENT_INTEGRITY_ADDRESS = (import.meta.env.VITE_SHIPMENT_INTEGRITY_ADDRESS || '').trim()
export const shipmentIntegrityConfigured = isAddress(SHIPMENT_INTEGRITY_ADDRESS)
const ABI = [
  'function foodTraceability() view returns (address)',
  'function recordShipment(uint256 batchId,string shipmentId,bytes32 digest)',
  'function getAnchor(uint256 batchId,string shipmentId) view returns (bytes32 digest,address recordedBy,uint64 recordedAt,bool exists)',
  'function verifyShipment(uint256 batchId,string shipmentId,bytes32 digest) view returns (bool)',
  'event ShipmentAnchored(uint256 indexed batchId,bytes32 indexed shipmentKey,bytes32 digest,address indexed recordedBy)'
]

export function hashShipment(shipment, batchId) {
  return sha256(toUtf8Bytes(canonicalShipment(shipment, batchId)))
}

async function checkedContract(runner) {
  if (!shipmentIntegrityConfigured) throw new Error('Shipment verification not configured')
  const contract = new Contract(SHIPMENT_INTEGRITY_ADDRESS, ABI, runner)
  if ((await contract.foodTraceability()).toLowerCase() !== CONTRACT_ADDRESS.toLowerCase()) {
    throw new Error('Shipment verification contract uses the wrong main contract')
  }
  return contract
}

export async function verifyShipmentIntegrity(batchId, shipment) {
  if (!shipmentIntegrityConfigured) return { status: 'unconfigured' }
  try {
    const provider = new JsonRpcProvider(PUBLIC_RPC_URL, Number(CHAIN_ID), { staticNetwork: true })
    if (await provider.getCode(SHIPMENT_INTEGRITY_ADDRESS) === '0x') return { status: 'unavailable' }
    const contract = await checkedContract(provider)
    const anchor = await contract.getAnchor(BigInt(batchId), shipment.shipmentId)
    if (!anchor.exists) return { status: 'not-anchored' }
    const calculated = hashShipment(shipment, batchId)
    return {
      status: calculated.toLowerCase() === anchor.digest.toLowerCase() ? 'verified' : 'modified',
      hash: calculated,
      recordedHash: anchor.digest,
      recordedBy: anchor.recordedBy,
      recordedAt: Number(anchor.recordedAt)
    }
  } catch (error) {
    return { status: 'unavailable', error: error.shortMessage || error.message }
  }
}

/**
 * Call from the existing shipment submit handler, BEFORE reporting an anchor
 * as successful. Caller must ensure MongoDB persists the exact same fields.
 * The wallet must be the current holder of the batch.
 */
export async function anchorShipment(batchId, shipment) {
  if (!window.ethereum) throw new Error('Connect MetaMask first')
  const wallet = new BrowserProvider(window.ethereum)
  const network = await wallet.getNetwork()
  if (network.chainId !== BigInt(CHAIN_ID)) throw new Error('Select Sepolia in MetaMask')
  const contract = await checkedContract(await wallet.getSigner())
  const digest = hashShipment(shipment, batchId)
  const transaction = await contract.recordShipment(BigInt(batchId), shipment.shipmentId, digest)
  const receipt = await transaction.wait()
  if (receipt.status !== 1) throw new Error('Shipment anchor transaction failed')
  return { hash: digest, transactionHash: receipt.hash, blockNumber: receipt.blockNumber }
}
