
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import hre from "hardhat";

const { viem } = await hre.network.create();

describe("OrganicFoodTraceability", function () {
  const harvestDate = 1792454400n;

  async function createContract() {
    const contract = await viem.deployContract("OrganicFoodTraceability");
    const [admin, farmer, distributor, retailer, outsider] =
      await viem.getWalletClients();

    return { contract, admin, farmer, distributor, retailer, outsider };
  }

  type TestContract = Awaited<ReturnType<typeof createContract>>["contract"];
  type FarmerWallet = Awaited<ReturnType<typeof createContract>>["farmer"];

  async function setupRoles(
    contract: TestContract,
    farmer: `0x${string}`,
    distributor: `0x${string}`,
    retailer: `0x${string}`
  ) {
    const farmerRole = await contract.read.FARMER_ROLE();
    const distributorRole = await contract.read.DISTRIBUTOR_ROLE();
    const retailerRole = await contract.read.RETAILER_ROLE();

    await contract.write.grantRole([farmerRole, farmer]);
    await contract.write.grantRole([distributorRole, distributor]);
    await contract.write.grantRole([retailerRole, retailer]);
  }

  async function registerTestBatch(
    contract: TestContract,
    farmer: FarmerWallet
  ) {
    await contract.write.registerBatch(
      ["Organic Tomatoes", "Farm A", harvestDate],
      { account: farmer.account }
    );
  }

  it("gives the deployer the admin role", async function () {
    const { contract, admin } = await createContract();

    const role = await contract.read.DEFAULT_ADMIN_ROLE();
    const result = await contract.read.hasRole([
      role,
      admin.account.address
    ]);

    assert.equal(result, true);
  });

  it("allows the admin to assign the farmer role", async function () {
    const { contract, farmer } = await createContract();

    const role = await contract.read.FARMER_ROLE();
    await contract.write.grantRole([role, farmer.account.address]);

    assert.equal(
      await contract.read.hasRole([role, farmer.account.address]),
      true
    );
  });

  it("rejects role assignment by a non-admin", async function () {
    const { contract, farmer, outsider } = await createContract();
    const role = await contract.read.FARMER_ROLE();

    await assert.rejects(
      contract.write.grantRole(
        [role, outsider.account.address],
        { account: farmer.account }
      )
    );
  });

  it("rejects registration without the farmer role", async function () {
    const { contract, outsider } = await createContract();

    await assert.rejects(
      contract.write.registerBatch(
        ["Organic Tomatoes", "Farm A", harvestDate],
        { account: outsider.account }
      )
    );
  });

  it("registers a food batch successfully", async function () {
    const { contract, farmer, distributor, retailer } =
      await createContract();

    await setupRoles(
      contract,
      farmer.account.address,
      distributor.account.address,
      retailer.account.address
    );

    await registerTestBatch(contract, farmer);

    const batch = await contract.read.getBatch([1n]);

    assert.equal(batch.productName, "Organic Tomatoes");
    assert.equal(batch.farmName, "Farm A");
    assert.equal(batch.harvestDate, harvestDate);

    assert.equal(
      batch.farmer.toLowerCase(),
      farmer.account.address.toLowerCase()
    );

    assert.equal(
      batch.currentHolder.toLowerCase(),
      farmer.account.address.toLowerCase()
    );

    assert.equal(batch.exists, true);
    assert.equal(batch.stage, 0);
  });

  it("assigns a unique ID to each batch", async function () {
    const { contract, farmer, distributor, retailer } =
      await createContract();

    await setupRoles(
      contract,
      farmer.account.address,
      distributor.account.address,
      retailer.account.address
    );

    await registerTestBatch(contract, farmer);
    await registerTestBatch(contract, farmer);

    assert.equal(await contract.read.nextBatchId(), 3n);
    assert.equal((await contract.read.getBatch([1n])).exists, true);
    assert.equal((await contract.read.getBatch([2n])).exists, true);
  });

  it("rejects an empty product name", async function () {
    const { contract, farmer, distributor, retailer } =
      await createContract();

    await setupRoles(
      contract,
      farmer.account.address,
      distributor.account.address,
      retailer.account.address
    );

    await viem.assertions.revertWith(
      contract.write.registerBatch(
        ["", "Farm A", harvestDate],
        { account: farmer.account }
      ),
      "Product name required"
    );
  });

  it("rejects an empty farm name", async function () {
    const { contract, farmer, distributor, retailer } =
      await createContract();

    await setupRoles(
      contract,
      farmer.account.address,
      distributor.account.address,
      retailer.account.address
    );

    await viem.assertions.revertWith(
      contract.write.registerBatch(
        ["Organic Tomatoes", "", harvestDate],
        { account: farmer.account }
      ),
      "Farm name required"
    );
  });

  it("rejects an invalid harvest date", async function () {
    const { contract, farmer, distributor, retailer } =
      await createContract();

    await setupRoles(
      contract,
      farmer.account.address,
      distributor.account.address,
      retailer.account.address
    );

    await viem.assertions.revertWith(
      contract.write.registerBatch(
        ["Organic Tomatoes", "Farm A", 0n],
        { account: farmer.account }
      ),
      "Invalid harvest date"
    );
  });

  it("rejects a future harvest date", async function () {
    const { contract, farmer, distributor, retailer } =
      await createContract();

    await setupRoles(
      contract,
      farmer.account.address,
      distributor.account.address,
      retailer.account.address
    );

    const publicClient = await viem.getPublicClient();
    const block = await publicClient.getBlock();
    const futureDate = block.timestamp + 86400n * 365n;

    await viem.assertions.revertWith(
      contract.write.registerBatch(
        ["Organic Tomatoes", "Farm A", futureDate],
        { account: farmer.account }
      ),
      "Harvest date is in the future"
    );
  });

  it("rejects a nonexistent batch", async function () {
    const { contract } = await createContract();

    await viem.assertions.revertWith(
      contract.read.getBatch([999n]),
      "Batch does not exist"
    );
  });

  it("transfers a batch from farmer to distributor", async function () {
    const { contract, farmer, distributor, retailer } =
      await createContract();

    await setupRoles(
      contract,
      farmer.account.address,
      distributor.account.address,
      retailer.account.address
    );

    await registerTestBatch(contract, farmer);

    await contract.write.transferBatch(
      [1n, distributor.account.address],
      { account: farmer.account }
    );

    const batch = await contract.read.getBatch([1n]);

    assert.equal(
      batch.currentHolder.toLowerCase(),
      distributor.account.address.toLowerCase()
    );

    assert.equal(batch.stage, 1);
  });

  it("transfers a batch from distributor to retailer", async function () {
    const { contract, farmer, distributor, retailer } =
      await createContract();

    await setupRoles(
      contract,
      farmer.account.address,
      distributor.account.address,
      retailer.account.address
    );

    await registerTestBatch(contract, farmer);

    await contract.write.transferBatch(
      [1n, distributor.account.address],
      { account: farmer.account }
    );

    await contract.write.transferBatch(
      [1n, retailer.account.address],
      { account: distributor.account }
    );

    const batch = await contract.read.getBatch([1n]);

    assert.equal(
      batch.currentHolder.toLowerCase(),
      retailer.account.address.toLowerCase()
    );

    assert.equal(batch.stage, 2);
  });

  it("rejects transfers from someone who is not the holder", async function () {
    const { contract, farmer, distributor, retailer, outsider } =
      await createContract();

    await setupRoles(
      contract,
      farmer.account.address,
      distributor.account.address,
      retailer.account.address
    );

    await registerTestBatch(contract, farmer);

    await viem.assertions.revertWith(
      contract.write.transferBatch(
        [1n, distributor.account.address],
        { account: outsider.account }
      ),
      "Not the current holder"
    );
  });

  it("rejects transfers to an unauthorised recipient", async function () {
    const { contract, farmer, distributor, retailer, outsider } =
      await createContract();

    await setupRoles(
      contract,
      farmer.account.address,
      distributor.account.address,
      retailer.account.address
    );

    await registerTestBatch(contract, farmer);

    await viem.assertions.revertWith(
      contract.write.transferBatch(
        [1n, outsider.account.address],
        { account: farmer.account }
      ),
      "Recipient is not a distributor"
    );
  });

  it("rejects transfers to the same holder", async function () {
    const { contract, farmer, distributor, retailer } =
      await createContract();

    await setupRoles(
      contract,
      farmer.account.address,
      distributor.account.address,
      retailer.account.address
    );

    await registerTestBatch(contract, farmer);

    await viem.assertions.revertWith(
      contract.write.transferBatch(
        [1n, farmer.account.address],
        { account: farmer.account }
      ),
      "Cannot transfer to yourself"
    );
  });

  it("rejects transfers after the retailer receives the batch", async function () {
    const { contract, farmer, distributor, retailer } =
      await createContract();

    await setupRoles(
      contract,
      farmer.account.address,
      distributor.account.address,
      retailer.account.address
    );

    await registerTestBatch(contract, farmer);

    await contract.write.transferBatch(
      [1n, distributor.account.address],
      { account: farmer.account }
    );

    await contract.write.transferBatch(
      [1n, retailer.account.address],
      { account: distributor.account }
    );

    await viem.assertions.revertWith(
      contract.write.transferBatch(
        [1n, farmer.account.address],
        { account: retailer.account }
      ),
      "Batch already reached retailer"
    );
  });

  it("rejects transfers of a nonexistent batch", async function () {
    const { contract, farmer, distributor } = await createContract();

    await viem.assertions.revertWith(
      contract.write.transferBatch(
        [999n, distributor.account.address],
        { account: farmer.account }
      ),
      "Batch does not exist"
    );
  });

  it("rejects transfers to the zero address", async function () {
    const { contract, farmer, distributor, retailer } =
      await createContract();

    await setupRoles(
      contract,
      farmer.account.address,
      distributor.account.address,
      retailer.account.address
    );

    await registerTestBatch(contract, farmer);

    await viem.assertions.revertWith(
      contract.write.transferBatch(
        [1n, "0x0000000000000000000000000000000000000000"],
        { account: farmer.account }
      ),
      "Invalid recipient"
    );
  });
});
