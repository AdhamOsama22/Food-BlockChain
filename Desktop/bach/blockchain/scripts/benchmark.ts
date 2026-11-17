import { network } from "hardhat";
import { mkdir, writeFile, appendFile, access } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import path from "node:path";

const count = Number(process.env.BENCH_COUNT ?? "100");
if (!Number.isInteger(count) || count < 1 || count > 10000) {
  throw new Error("BENCH_COUNT must be an integer from 1 to 10000");
}

function ms(n: number) { return n.toFixed(3); }
function percentile(sorted: number[], p: number) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}
function csvRow(values: (string | number | bigint)[]) {
  return values.map(v => `"${String(v).replaceAll('"', '""')}"`).join(",") + "\n";
}
function mb(bytes: number) { return bytes / (1024 * 1024); }

// Resource measurements describe THIS Node.js process (including Hardhat's
// simulated blockchain), not total system usage or true on-chain storage size.
type ResourceSnapshot = {
  rssBytes: number;
  heapUsedBytes: number;
  externalBytes: number;
};
function takeSnapshot(): ResourceSnapshot {
  const m = process.memoryUsage();
  return { rssBytes: m.rss, heapUsedBytes: m.heapUsed, externalBytes: m.external };
}
function maxSnapshot(a: ResourceSnapshot, b: ResourceSnapshot): ResourceSnapshot {
  return {
    rssBytes: Math.max(a.rssBytes, b.rssBytes),
    heapUsedBytes: Math.max(a.heapUsedBytes, b.heapUsedBytes),
    externalBytes: Math.max(a.externalBytes, b.externalBytes),
  };
}
function cpuMetrics(start: NodeJS.CpuUsage, elapsedMs: number) {
  const delta = process.cpuUsage(start);
  const cpuMs = (delta.user + delta.system) / 1000;
  return {
    cpuMs,
    // One full logical core corresponds to 100%; multicore workloads may exceed 100%.
    cpuPercentOfOneCore: elapsedMs > 0 ? (100 * cpuMs) / elapsedMs : 0,
  };
}
async function fileExists(file: string) {
  try { await access(file); return true; } catch { return false; }
}

async function main() {
  // Fresh, isolated Hardhat simulated chain for this run.
  const { viem } = await network.create();
  const publicClient = await viem.getPublicClient();
  const [admin] = await viem.getWalletClients();
  const contract = await viem.deployContract("OrganicFoodTraceability");
  const farmerRole = await contract.read.FARMER_ROLE();
  const grantHash = await contract.write.grantRole([farmerRole, admin.account.address]);
  const grantReceipt = await publicClient.waitForTransactionReceipt({ hash: grantHash });
  if (grantReceipt.status !== "success") throw new Error("Farmer role grant failed");

  const folder = path.resolve("benchmark-results");
  await mkdir(folder, { recursive: true });
  const detailsFile = path.join(folder, `transactions-${count}.csv`);
  const lines = [csvRow(["number", "batchId", "transactionHash", "confirmationMs", "gasUsed", "status"])];

  const confirmationTimes: number[] = [];
  let totalGas = 0n;
  const harvestDate = 1700000000n; // Valid past timestamp.

  // Memory baseline is taken AFTER contract deployment/role setup, and before
  // registrations; sampling every 25 iterations reduces measurement overhead.
  const initialMemory = takeSnapshot();
  let writePeakMemory = initialMemory;
  const writeCpuStart = process.cpuUsage();

  console.log(`Running ${count} registrations on a fresh Hardhat simulated chain...`);
  const writeStart = performance.now();
  for (let i = 1; i <= count; i++) {
    const expectedBatchId = BigInt(i);
    const t0 = performance.now();
    const hash = await contract.write.registerBatch([`Organic Tomatoes ${i}`, `Farm ${i}`, harvestDate]);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const elapsed = performance.now() - t0;
    if (receipt.status !== "success") throw new Error(`Registration ${i} failed: ${hash}`);
    const actualBatchId = await contract.read.nextBatchId() - 1n;
    if (actualBatchId !== expectedBatchId) {
      throw new Error(`Expected batch ${expectedBatchId}, got ${actualBatchId}`);
    }
    confirmationTimes.push(elapsed);
    totalGas += receipt.gasUsed;
    lines.push(csvRow([i, actualBatchId, hash, ms(elapsed), receipt.gasUsed, receipt.status]));
    if (i % 25 === 0 || i === count) {
      writePeakMemory = maxSnapshot(writePeakMemory, takeSnapshot());
    }
    if (i % 100 === 0 || i === count) console.log(`Registered ${i}/${count}`);
  }
  const totalWriteMs = performance.now() - writeStart;
  const writeCpu = cpuMetrics(writeCpuStart, totalWriteMs);
  const afterWriteMemory = takeSnapshot();
  writePeakMemory = maxSnapshot(writePeakMemory, afterWriteMemory);

  console.log(`Measuring ${count} independent getBatch() reads...`);
  const readTimes: number[] = [];
  let readPeakMemory = afterWriteMemory;
  const readCpuStart = process.cpuUsage();
  const readStart = performance.now();
  for (let i = 1; i <= count; i++) {
    const t0 = performance.now();
    const batch = await contract.read.getBatch([BigInt(i)]);
    const elapsed = performance.now() - t0;
    if (!batch.exists || batch.productName !== `Organic Tomatoes ${i}`) {
      throw new Error(`Readback failed for batch ${i}`);
    }
    readTimes.push(elapsed);
    if (i % 25 === 0 || i === count) {
      readPeakMemory = maxSnapshot(readPeakMemory, takeSnapshot());
    }
  }
  const totalReadMs = performance.now() - readStart;
  const readCpu = cpuMetrics(readCpuStart, totalReadMs);
  const afterReadMemory = takeSnapshot();
  readPeakMemory = maxSnapshot(readPeakMemory, afterReadMemory);

  const sortedWrite = [...confirmationTimes].sort((a, b) => a - b);
  const sortedRead = [...readTimes].sort((a, b) => a - b);
  const summary = {
    count,
    writeTotalSec: totalWriteMs / 1000,
    registrationThroughput: count / (totalWriteMs / 1000),
    avgWriteMs: confirmationTimes.reduce((a, b) => a + b, 0) / count,
    p95WriteMs: percentile(sortedWrite, 0.95),
    avgGasUsed: Number(totalGas) / count,
    totalGasUsed: totalGas.toString(),
    readTotalSec: totalReadMs / 1000,
    readThroughput: count / (totalReadMs / 1000),
    avgReadMs: readTimes.reduce((a, b) => a + b, 0) / count,
    p95ReadMs: percentile(sortedRead, 0.95),
  };

  // Keep the existing transaction-level CSV and summary.csv column structure.
  // A new run replaces transactions-N.csv and appends one row to summary.csv.
  await writeFile(detailsFile, lines.join(""), "utf8");
  const summaryFile = path.join(folder, "summary.csv");
  const headers = csvRow(["count", "writeTotalSec", "registrationThroughputOpsPerSec", "avgWriteMs", "p95WriteMs", "avgGasUsed", "totalGasUsed", "readTotalSec", "readThroughputOpsPerSec", "avgReadMs", "p95ReadMs"]);
  const values = csvRow([count, ms(summary.writeTotalSec), ms(summary.registrationThroughput), ms(summary.avgWriteMs), ms(summary.p95WriteMs), ms(summary.avgGasUsed), summary.totalGasUsed, ms(summary.readTotalSec), ms(summary.readThroughput), ms(summary.avgReadMs), ms(summary.p95ReadMs)]);
  if (!(await fileExists(summaryFile))) await writeFile(summaryFile, headers + values, "utf8");
  else await appendFile(summaryFile, values, "utf8");

  // Additional measurements go into their own CSV, without changing summary.csv.
  const resourcesFile = path.join(folder, "resources.csv");
  const resourceHeaders = csvRow([
    "count", "writeCpuMs", "writeCpuPercentOneCore", "readCpuMs", "readCpuPercentOneCore",
    "initialRssMB", "writePeakRssMB", "afterWriteRssMB", "readPeakRssMB", "afterReadRssMB",
    "initialHeapUsedMB", "writePeakHeapUsedMB", "afterWriteHeapUsedMB", "readPeakHeapUsedMB", "afterReadHeapUsedMB",
    "initialExternalMB", "writePeakExternalMB", "readPeakExternalMB"
  ]);
  const resourceValues = csvRow([
    count, ms(writeCpu.cpuMs), ms(writeCpu.cpuPercentOfOneCore),
    ms(readCpu.cpuMs), ms(readCpu.cpuPercentOfOneCore),
    ms(mb(initialMemory.rssBytes)), ms(mb(writePeakMemory.rssBytes)),
    ms(mb(afterWriteMemory.rssBytes)), ms(mb(readPeakMemory.rssBytes)), ms(mb(afterReadMemory.rssBytes)),
    ms(mb(initialMemory.heapUsedBytes)), ms(mb(writePeakMemory.heapUsedBytes)),
    ms(mb(afterWriteMemory.heapUsedBytes)), ms(mb(readPeakMemory.heapUsedBytes)), ms(mb(afterReadMemory.heapUsedBytes)),
    ms(mb(initialMemory.externalBytes)), ms(mb(writePeakMemory.externalBytes)), ms(mb(readPeakMemory.externalBytes))
  ]);
  if (!(await fileExists(resourcesFile))) await writeFile(resourcesFile, resourceHeaders + resourceValues, "utf8");
  else await appendFile(resourcesFile, resourceValues, "utf8");

  const resources = {
    writeCpuMs: ms(writeCpu.cpuMs),
    writeCpuPercentOneCore: ms(writeCpu.cpuPercentOfOneCore),
    readCpuMs: ms(readCpu.cpuMs),
    readCpuPercentOneCore: ms(readCpu.cpuPercentOfOneCore),
    initialRssMB: ms(mb(initialMemory.rssBytes)),
    writePeakRssMB: ms(mb(writePeakMemory.rssBytes)),
    afterWriteRssMB: ms(mb(afterWriteMemory.rssBytes)),
    readPeakRssMB: ms(mb(readPeakMemory.rssBytes)),
    afterReadRssMB: ms(mb(afterReadMemory.rssBytes)),
    writePeakHeapUsedMB: ms(mb(writePeakMemory.heapUsedBytes)),
    readPeakHeapUsedMB: ms(mb(readPeakMemory.heapUsedBytes)),
  };
  console.log("\nRESULTS (Hardhat local simulation, sequential transactions):");
  console.table(summary);
  console.log("\nNODE.JS PROCESS CPU/RAM (not system-wide or actual blockchain disk storage):");
  console.table(resources);
  console.log(`Saved ${detailsFile}`);
  console.log(`Saved ${summaryFile}`);
  console.log(`Saved ${resourcesFile}`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
