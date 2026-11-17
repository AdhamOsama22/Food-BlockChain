import { network } from "hardhat";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

// Measures unique EVM storage slots written by registerBatch transactions.
// This is NOT the physical size of a blockchain node on disk.
const count = Number(process.env.BENCH_COUNT ?? "100");
if (!Number.isInteger(count) || count < 1 || count > 10000) {
  throw new Error("BENCH_COUNT must be an integer between 1 and 10000");
}

type TraceStep = { op?: string; stack?: string[]; depth?: number };
type TransactionTrace = { failed?: boolean; structLogs?: TraceStep[] };

function csv(items: (number | string)[]): string {
  return items.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(",") + "\n";
}

function normalizeSlot(raw: string): string {
  const s = raw.toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]+$/.test(s) || s.length > 64) {
    throw new Error(`Unexpected storage-slot value in trace: ${raw}`);
  }
  return `0x${s.padStart(64, "0")}`;
}

async function main() {
  const connection = await network.create();
  const { viem, provider } = connection;
  const publicClient = await viem.getPublicClient();
  const [admin] = await viem.getWalletClients();
  const contract = await viem.deployContract("OrganicFoodTraceability");
  const role = await contract.read.FARMER_ROLE();
  const grantHash = await contract.write.grantRole([role, admin.account.address]);
  const granted = await publicClient.waitForTransactionReceipt({ hash: grantHash });
  if (granted.status !== "success") throw new Error("Could not grant Farmer role");

  const allSlots = new Set<string>();
  let sstoreExecutions = 0;
  let totalGasUsed = 0n;
  const rows: string[] = [
    csv(["registeredBatches", "distinctWrittenStorageSlots", "writtenSlotCapacityBytes", "sstoreExecutions", "cumulativeRegistrationGas"]),
  ];
  const checkpoints = new Set([100, 500, 1000, 5000, 10000, count].filter(n => n <= count));
  console.log(`Tracking unique contract storage slots across ${count} registrations...`);
  for (let i = 1; i <= count; i++) {
    const hash = await contract.write.registerBatch([
      `Organic Tomatoes ${i}`,
      `Farm ${i}`,
      1700000000n,
    ]);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`Batch ${i} failed`);
    totalGasUsed += receipt.gasUsed;

    // Hardhat's debug RPC returns opcode-by-opcode execution data.
    const result = await provider.request({
      method: "debug_traceTransaction",
      params: [hash, { disableMemory: true, disableStorage: true }],
    });
    const trace = result as TransactionTrace;
    if (trace.failed || !Array.isArray(trace.structLogs)) {
      throw new Error("Hardhat did not return a usable execution trace");
    }
    for (const step of trace.structLogs) {
      if (step.op !== "SSTORE") continue;
      const stack = step.stack;
      if (!stack?.length) throw new Error("SSTORE trace has no stack; cannot identify slots");
      // For SSTORE, the top of the stack is the storage slot key.
      allSlots.add(normalizeSlot(stack[stack.length - 1]));
      sstoreExecutions++;
    }
    if (checkpoints.has(i)) {
      const writtenBytes = allSlots.size * 32;
      rows.push(csv([i, allSlots.size, writtenBytes, sstoreExecutions, totalGasUsed.toString()]));
      console.log(`${i} batches: ${allSlots.size} distinct slots written; ${writtenBytes} bytes of written-slot capacity (proxy)`);
    }
  }
  const outputFolder = path.resolve("benchmark-results");
  await mkdir(outputFolder, { recursive: true });
  const output = path.join(outputFolder, `storage-${count}.csv`);
  await writeFile(output, rows.join(""), "utf8");
  console.log(`Saved ${output}`);
  console.log("Note: 32 bytes per distinct written storage slot is only a written-slot capacity proxy, not actual on-disk blockchain size.");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
