
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

function calculateHash(file) {
  return createHash("sha256").update(file).digest("hex");
}

async function main() {
  const filePath = process.argv[2];
  const cid = process.argv[3];

  if (!filePath || !cid) {
    console.error("Please provide the PDF file and its CID.");
    process.exitCode = 1;
    return;
  }

  const originalFile = await readFile(filePath);
  const originalHash = calculateHash(originalFile);

  const response = await fetch(
    `https://gateway.pinata.cloud/ipfs/${cid}`
  );

  if (!response.ok) {
  throw new Error(
    `IPFS download failed: ${response.status} ${response.statusText}`
  );
  }

  const downloadedFile = Buffer.from(await response.arrayBuffer());
  const downloadedHash = calculateHash(downloadedFile);

  console.log("Original SHA-256:", originalHash);
  console.log("IPFS SHA-256:    ", downloadedHash);

  if (originalHash === downloadedHash) {
    console.log("SUCCESS: The certificate matches.");
  } else {
    console.log("FAILED: The certificate does not match.");
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
