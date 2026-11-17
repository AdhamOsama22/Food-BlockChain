
import { network } from "hardhat";
import assert from "node:assert/strict";

async function main() {
  const { viem } = await network.create();

  const [admin, farmer, distributor, retailer] =
    await viem.getWalletClients();

  const publicClient = await viem.getPublicClient();

  // Deploy a contract for this local demonstration.
  const contract = await viem.deployContract(
    "OrganicFoodTraceability"
  );

  // Assign roles to the supply-chain participants.
  const farmerRole = await contract.read.FARMER_ROLE();
  const distributorRole = await contract.read.DISTRIBUTOR_ROLE();
  const retailerRole = await contract.read.RETAILER_ROLE();

  await contract.write.grantRole([
    farmerRole,
    farmer.account.address
  ]);

  await contract.write.grantRole([
    distributorRole,
    distributor.account.address
  ]);

  await contract.write.grantRole([
    retailerRole,
    retailer.account.address
  ]);

  // Register one food batch.
  const block = await publicClient.getBlock();
  const harvestDate = block.timestamp - 86400n;

  await contract.write.registerBatch(
    ["Organic Tomatoes", "Farm A", harvestDate],
    { account: farmer.account }
  );

  const batchId = 1n;

  // Transfer the batch from farmer to distributor.
  await contract.write.transferBatch(
    [batchId, distributor.account.address],
    { account: farmer.account }
  );

  // Transfer the batch from distributor to retailer.
  await contract.write.transferBatch(
    [batchId, retailer.account.address],
    { account: distributor.account }
  );

  // Read the original batch registration event.
  const registrations = await publicClient.getContractEvents({
    address: contract.address,
    abi: contract.abi,
    eventName: "BatchRegistered",
    args: { batchId },
    fromBlock: 0n
  });

  // Read every transfer event for this batch.
  const transfers = await publicClient.getContractEvents({
    address: contract.address,
    abi: contract.abi,
    eventName: "BatchTransferred",
    args: { batchId },
    fromBlock: 0n
  });

  const batch = await contract.read.getBatch([batchId]);

  // Check that the expected history was recorded.
  assert.equal(registrations.length, 1);
  assert.equal(transfers.length, 2);

  assert.equal(
    transfers[0].args.from?.toLowerCase(),
    farmer.account.address.toLowerCase()
  );

  assert.equal(
    transfers[0].args.to?.toLowerCase(),
    distributor.account.address.toLowerCase()
  );

  assert.equal(
    transfers[1].args.from?.toLowerCase(),
    distributor.account.address.toLowerCase()
  );

  assert.equal(
    transfers[1].args.to?.toLowerCase(),
    retailer.account.address.toLowerCase()
  );

  assert.equal(
    batch.currentHolder.toLowerCase(),
    retailer.account.address.toLowerCase()
  );

  // Print the batch's recorded journey.
  console.log("\nFOOD BATCH HISTORY");
  console.log("-------------------------");
  console.log("Batch ID:", batchId.toString());
  console.log("Product:", batch.productName);
  console.log("Farm:", batch.farmName);

  console.log("\n1. Batch registered");
  console.log("Farmer:", registrations[0].args.farmer);
  console.log("Block:", registrations[0].blockNumber.toString());

  for (let i = 0; i < transfers.length; i++) {
    const transfer = transfers[i];

    console.log(`\n${i + 2}. Custody transfer`);
    console.log("From:", transfer.args.from);
    console.log("To:", transfer.args.to);
    console.log("Block:", transfer.blockNumber.toString());
  }

  console.log("\nCurrent holder:", batch.currentHolder);
  console.log("SUCCESS: Complete custody history verified.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
