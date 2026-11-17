/** Hardhat 3 + @nomicfoundation/hardhat-toolbox-viem or hardhat-viem plugin.
 * Run from the blockchain folder after `npx hardhat compile`:
 * npx hardhat run scripts/deploy-processing.mjs --network sepolia
 */
import { network } from 'hardhat'

const EXISTING_CONTRACT = '0x7ead9cd6c3843AFeaae96e77959d2DC44809429e'
const { viem } = await network.connect()
if (!viem) throw new Error('Hardhat viem plugin is required for this deployment script')
const publicClient = await viem.getPublicClient()
const chainId = await publicClient.getChainId()
if (chainId !== 11155111) throw new Error(`Refusing non-Sepolia network: ${chainId}`)
if ((await publicClient.getBytecode({ address: EXISTING_CONTRACT })) === undefined) {
  throw new Error('Existing OrganicTrace contract not found at the expected address')
}
const addon = await viem.deployContract('OrganicTraceProcessing', [EXISTING_CONTRACT])
console.log('Processing companion deployed on Sepolia:', addon.address)
console.log('KEEP the existing OrganicFoodTraceability contract and its current address unchanged.')
console.log(`Add VITE_PROCESSING_CONTRACT_ADDRESS=${addon.address} to frontend/.env`)
