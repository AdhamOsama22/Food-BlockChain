import { Contract, JsonRpcProvider, isAddress } from 'ethers'
import { PUBLIC_RPC_URL, CHAIN_ID, CONTRACT_ADDRESS } from './sepoliaConfig.js'

export const PROCESSING_ADDRESS = (import.meta.env.VITE_PROCESSING_CONTRACT_ADDRESS || '').trim()
export const PROCESSING_ABI = [
  'function foodTraceability() view returns (address)',
  'function DEFAULT_ADMIN_ROLE() view returns (bytes32)',
  'function PROCESSOR_ROLE() view returns (bytes32)',
  'function hasRole(bytes32,address) view returns (bool)',
  'function grantRole(bytes32,address)',
  'function revokeRole(bytes32,address)',
  'function assignedProcessor(uint256) view returns (address)',
  'function assignProcessor(uint256,address)',
  'function recordProcessing(uint256,uint256,uint256,string)',
  'function getProcessing(uint256) view returns (tuple(address processor,uint256 receivedQuantityKg,uint256 processingDate,string processingMethod,uint256 recordedAt,uint256 recordedBlock,bool exists))',
  'event ProcessingRecorded(uint256 indexed batchId,address indexed processor,uint256 receivedQuantityKg,uint256 processingDate,string processingMethod)'
]

export const processingConfigured = isAddress(PROCESSING_ADDRESS)

export async function processingReader() {
  if (!processingConfigured) return null
  const provider = new JsonRpcProvider(PUBLIC_RPC_URL, Number(CHAIN_ID), { staticNetwork: true })
  if (await provider.getCode(PROCESSING_ADDRESS) === '0x') throw new Error('Processing contract not deployed on Sepolia')
  const contract = new Contract(PROCESSING_ADDRESS, PROCESSING_ABI, provider)
  if ((await contract.foodTraceability()).toLowerCase() !== CONTRACT_ADDRESS.toLowerCase()) {
    throw new Error('Processing contract references the wrong OrganicTrace main contract')
  }
  return contract
}

export async function loadProcessing(batchId) {
  const contract = await processingReader()
  if (!contract) return { configured: false, exists: false }
  const record = await contract.getProcessing(BigInt(batchId))
  if (!record.exists) return { configured: true, exists: false }
  return {
    configured: true,
    exists: true,
    processor: record.processor,
    quantityKg: record.receivedQuantityKg.toString(),
    method: record.processingMethod,
    date: Number(record.processingDate),
    timestamp: Number(record.recordedAt),
    block: Number(record.recordedBlock)
  }
}
