/** Shared Sepolia settings for the React frontend. Never put private keys here. */
export const CHAIN_ID = 11155111n
export const NETWORK_NAME = 'Sepolia'
export const CONTRACT_ADDRESS = '0x7ead9cd6c3843AFeaae96e77959d2DC44809429e'
export const SEPOLIA_EXPLORER = 'https://sepolia.etherscan.io'

// Public RPC for consumer verification without MetaMask. Override via .env if needed.
// Never place a private deployment key in VITE_ variables (exposed to browsers).
export const PUBLIC_RPC_URL = import.meta.env.VITE_SEPOLIA_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com'

// For COMPLETE product journeys set VITE_SEPOLIA_DEPLOYMENT_BLOCK to the
// block containing the contract deployment (shown on Sepolia Etherscan).
// Without it, only the most recent 50,000 blocks are scanned to protect
// public RPCs from expensive queries.
export async function getEventStartBlock(provider) {
  const explicit = import.meta.env.VITE_SEPOLIA_DEPLOYMENT_BLOCK
  if (explicit !== undefined && explicit !== '') {
    const number = Number(explicit)
    if (!Number.isSafeInteger(number) || number < 0) {
      throw new Error('VITE_SEPOLIA_DEPLOYMENT_BLOCK must be a nonnegative integer.')
    }
    return number
  }
  const latest = await provider.getBlockNumber()
  return Math.max(0, latest - 50000)
}
