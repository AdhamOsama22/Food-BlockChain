
import { network } from "hardhat";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const cid = "bafkreiattzhqur6ieex7cl7gjfy7scwnm6avi66skcy63cbqfamxwtizea";

async function main() {
  const { viem } = await network.create();
  const [admin, farmer, certifier] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();

  // Calculate the hash of the actual certificate PDF.
  const pdf = await readFile("sample_certificate.pdf");
  const fileHash = `0x${createHash("sha256").update(pdf).digest("hex")}` as `0x${string}`;

  // Deploy a new contract on the local test blockchain.
  const contract = await viem.deployContract("OrganicFoodTraceability");

  // Give the farmer and certifier their permissions.
  const farmerRole = await contract.read.FARMER_ROLE();
  const certifierRole = await contract.read.CERTIFIER_ROLE();

  await contract.write.grantRole([farmerRole, farmer.account.address]);
  await contract.write.grantRole([certifierRole, certifier.account.address]);

  // Create a food batch with a valid harvest date.
  const block = await publicClient.getBlock();
  const issueDate = block.timestamp - 86400n;
  const expiryDate = block.timestamp + 365n * 86400n;

  await contract.write.registerBatch(
    ["Organic Tomatoes", "Farm A", issueDate],
    { account: farmer.account }
  );

  // Store the real PDF's CID and SHA-256 hash.
  await contract.write.registerCertificate(
    [
      1n,
      "CERT-001",
      cid,
      fileHash,
      issueDate,
      expiryDate
    ],
    { account: certifier.account }
  );

  // Read the certificate back from the blockchain.
  const saved = await contract.read.getCertificate([1n]);
  const valid = await contract.read.isCertificateValid([1n]);

  if (saved.ipfsCid !== cid || saved.fileHash !== fileHash || !valid) {
    throw new Error("Certificate registration verification failed");
  }

  console.log("Contract:", contract.address);
  console.log("Batch ID: 1");
  console.log("CID:", saved.ipfsCid);
  console.log("SHA-256:", saved.fileHash);
  console.log("Certificate valid:", valid);
  console.log("SUCCESS: Real certificate information saved on blockchain.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
