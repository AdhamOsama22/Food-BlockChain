import hre from 'hardhat'

// Deploy on Sepolia after testing locally. Do not paste your private key here.
const MAIN_CONTRACT = '0x7ead9cd6c3843AFeaae96e77959d2DC44809429e'

async function main() {
  const { viem } = await hre.network.connect()
  const deployed = await viem.deployContract('ShipmentIntegrity', [MAIN_CONTRACT])
  console.log('ShipmentIntegrity deployed at:', deployed.address)
  console.log('Set VITE_SHIPMENT_INTEGRITY_ADDRESS to this address during your Vite build.')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
