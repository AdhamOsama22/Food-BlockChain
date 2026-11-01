
import { network } from "hardhat";

async function main() {
  const { viem } = await network.create();

  const [admin, farmer, distributor, retailer, certifier] =
    await viem.getWalletClients();

  const publicClient = await viem.getPublicClient();

  // Deploy the contract to a temporary local blockchain.
  const contract = await viem.deployContract(
    "OrganicFoodTraceability"
  );

  const results: { operation: string; gasUsed: string }[] = [];

  // Read the gas consumed by a completed transaction.
  async function recordGas(
    operation: string,
    transactionHash: `0x${string}`
  ) {
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: transactionHash
    });

    if (receipt.status !== "success") {
      throw new Error(`${operation} transaction failed`);
    }

    results.push({
      operation,
      gasUsed: receipt.gasUsed.toString()
    });
  }

  // Assign roles so each participant can perform their actions.
  const farmerRole = await contract.read.FARMER_ROLE();
  const distributorRole = await contract.read.DISTRIBUTOR_ROLE();
  const retailerRole = await contract.read.RETAILER_ROLE();
  const certifierRole = await contract.read.CERTIFIER_ROLE();

  await contract.write.grantRole([
    farmerRole, farmer.account.address
  ]);

  await contract.write.grantRole([
    distributorRole, distributor.account.address
  ]);

  await contract.write.grantRole([
    retailerRole, retailer.account.address
  ]);

  await contract.write.grantRole([
    certifierRole, certifier.account.address
  ]);

  // Use valid dates based on the local blockchain time.
  const block = await publicClient.getBlock();
  const harvestDate = block.timestamp - 86400n;
  const expiryDate = block.timestamp + 365n * 86400n;

  // 1. Register a food batch.
  const registerHash = await contract.write.registerBatch(
    ["Organic Tomatoes", "Farm A", harvestDate],
    { account: farmer.account }
  );

  await recordGas("Register batch", registerHash);

  // 2. Transfer from farmer to distributor.
  const firstTransferHash = await contract.write.transferBatch(
    [1n, distributor.account.address],
    { account: farmer.account }
  );

  await recordGas("Farmer to distributor", firstTransferHash);

  // 3. Transfer from distributor to retailer.
  const secondTransferHash = await contract.write.transferBatch(
    [1n, retailer.account.address],
    { account: distributor.account }
  );

  await recordGas("Distributor to retailer", secondTransferHash);

  // 4. Register a certificate.
  // Dummy values are sufficient for measuring gas usage.
  const sampleCid = "bafy-test-certificate-cid";
  const sampleHash = `0x${"ab".repeat(32)}` as `0x${string}`;

  const certificateHash = await contract.write.registerCertificate(
    [
      1n,
      "CERT-001",
      sampleCid,
      sampleHash,
      harvestDate,
      expiryDate
    ],
    { account: certifier.account }
  );

  await recordGas("Register certificate", certificateHash);

  // 5. Revoke the certificate.
  const revokeHash = await contract.write.revokeCertificate(
    [1n],
    { account: certifier.account }
  );

  await recordGas("Revoke certificate", revokeHash);

  console.log("\nBLOCKCHAIN GAS REPORT");
  console.log("----------------------------");
  console.table(results);

  console.log("SUCCESS: Gas measurements completed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
