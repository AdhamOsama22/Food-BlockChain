
import { network } from "hardhat";
import { performance } from "node:perf_hooks";

async function main() {
  const { viem } = await network.create();

  const [admin, farmer, distributor, retailer, certifier] =
    await viem.getWalletClients();

  const publicClient = await viem.getPublicClient();

  // Deploy the contract on a temporary local blockchain.
  const contract = await viem.deployContract(
    "OrganicFoodTraceability"
  );

  const results: {
    operation: string;
    latencyMs: string;
  }[] = [];

  // Measure the time from submitting a transaction
  // until its receipt is available.
  async function measureLatency(
    operation: string,
    sendTransaction: () => Promise<`0x${string}`>
  ) {
    const start = performance.now();

    const transactionHash = await sendTransaction();

    const receipt = await publicClient.waitForTransactionReceipt({
      hash: transactionHash
    });

    const end = performance.now();

    if (receipt.status !== "success") {
      throw new Error(`${operation} failed`);
    }

    results.push({
      operation,
      latencyMs: (end - start).toFixed(2)
    });
  }

  // Assign roles to the participants.
  const farmerRole = await contract.read.FARMER_ROLE();
  const distributorRole = await contract.read.DISTRIBUTOR_ROLE();
  const retailerRole = await contract.read.RETAILER_ROLE();
  const certifierRole = await contract.read.CERTIFIER_ROLE();

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

  await contract.write.grantRole([
    certifierRole,
    certifier.account.address
  ]);

  const block = await publicClient.getBlock();
  const harvestDate = block.timestamp - 86400n;
  const expiryDate = block.timestamp + 365n * 86400n;

  // 1. Register a food batch.
  await measureLatency("Register batch", () =>
    contract.write.registerBatch(
      ["Organic Tomatoes", "Farm A", harvestDate],
      { account: farmer.account }
    )
  );

  // 2. Farmer transfers the batch to a distributor.
  await measureLatency("Farmer to distributor", () =>
    contract.write.transferBatch(
      [1n, distributor.account.address],
      { account: farmer.account }
    )
  );

  // 3. Distributor transfers the batch to a retailer.
  await measureLatency("Distributor to retailer", () =>
    contract.write.transferBatch(
      [1n, retailer.account.address],
      { account: distributor.account }
    )
  );

  // Use sample certificate information for this measurement.
  const sampleCid = "bafy-test-certificate-cid";
  const sampleHash = `0x${"ab".repeat(32)}` as `0x${string}`;

  // 4. Register a certificate.
  await measureLatency("Register certificate", () =>
    contract.write.registerCertificate(
      [
        1n,
        "CERT-001",
        sampleCid,
        sampleHash,
        harvestDate,
        expiryDate
      ],
      { account: certifier.account }
    )
  );

  // 5. Revoke the certificate.
  await measureLatency("Revoke certificate", () =>
    contract.write.revokeCertificate(
      [1n],
      { account: certifier.account }
    )
  );

  console.log("\nBLOCKCHAIN LATENCY REPORT");
  console.log("----------------------------");
  console.table(results);

  console.log("SUCCESS: Latency measurements completed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
