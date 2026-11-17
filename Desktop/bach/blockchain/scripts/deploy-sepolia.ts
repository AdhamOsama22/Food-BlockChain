
import { network } from "hardhat";

async function main() {
  const { viem, networkName } = await network.create();

  if (networkName !== "sepolia") {
    throw new Error("This script must run on Sepolia.");
  }

  const publicClient = await viem.getPublicClient();
  const chainId = await publicClient.getChainId();

  if (chainId !== 11155111) {
    throw new Error(`Wrong chain ID: ${chainId}`);
  }

  const [admin] = await viem.getWalletClients();

  if (!admin) {
    throw new Error("Deployment wallet not configured.");
  }

  console.log("Deploying OrganicFoodTraceability...");
  console.log("Network:", networkName);
  console.log("Administrator:", admin.account.address);

  const contract = await viem.deployContract(
    "OrganicFoodTraceability"
  );

  const code = await publicClient.getCode({
    address: contract.address
  });

  if (!code || code === "0x") {
    throw new Error("Contract deployment failed.");
  }

  const adminRole = await contract.read.DEFAULT_ADMIN_ROLE();

  const isAdmin = await contract.read.hasRole([
    adminRole,
    admin.account.address
  ]);

  if (!isAdmin) {
    throw new Error("Admin role was not assigned.");
  }

  console.log("\nSEPOLIA DEPLOYMENT SUCCESSFUL");
  console.log("Contract:", contract.address);
  console.log("Administrator:", admin.account.address);
  console.log("Admin role assigned:", isAdmin);
  console.log("Next batch ID:", await contract.read.nextBatchId());
  console.log(
    `Explorer: https://sepolia.etherscan.io/address/${contract.address}`
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
