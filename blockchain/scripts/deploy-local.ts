
import { network } from "hardhat";

async function main() {
  const { viem } = await network.create();
  const publicClient = await viem.getPublicClient();

  const contract = await viem.deployContract("OrganicFoodTraceability");

  const code = await publicClient.getCode({
    address: contract.address
  });

  if (!code || code === "0x") {
    throw new Error("Contract deployment failed");
  }

  const [admin] = await viem.getWalletClients();
  const adminRole = await contract.read.DEFAULT_ADMIN_ROLE();

  const isAdmin = await contract.read.hasRole([
    adminRole,
    admin.account.address
  ]);

  if (!isAdmin) {
    throw new Error("Admin role was not assigned");
  }

  console.log("\nLOCAL DEPLOYMENT");
  console.log("Contract:", contract.address);
  console.log("Administrator:", admin.account.address);
  console.log("Admin role assigned:", isAdmin);
  console.log("Next batch ID:", await contract.read.nextBatchId());
  console.log("SUCCESS: Contract deployed successfully.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
