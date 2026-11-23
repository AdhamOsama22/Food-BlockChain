
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { network } from "hardhat";

describe("ShipmentIntegrity", () => {
  let viem: any;
  let farmer: any;
  let distributor: any;
  let retailer: any;
  let outsider: any;
  let food: any;
  let shipment: any;
  let farmerShipment: any;
  let outsiderShipment: any;

  const BATCH_ID = 1n;
  const SHIPMENT_ID = "SHIP-001";

  const digest = (
    value: string
  ): `0x${string}` =>
    `0x${createHash("sha256")
      .update(value)
      .digest("hex")}`;

  const HASH = digest("Original shipment data");
  const WRONG_HASH = digest("Modified shipment data");

  beforeEach(async () => {
    const connection = await network.connect();
    viem = connection.viem;

    [farmer, distributor, retailer, outsider] =
      await viem.getWalletClients();

    // Deploy the existing main contract locally.
    food = await viem.deployContract(
      "OrganicFoodTraceability"
    );

    // Give the test wallets their roles.
    const farmerRole = await food.read.FARMER_ROLE();
    const distributorRole =
      await food.read.DISTRIBUTOR_ROLE();
    const retailerRole = await food.read.RETAILER_ROLE();

    await food.write.grantRole([
      farmerRole,
      farmer.account.address
    ]);

    await food.write.grantRole([
      distributorRole,
      distributor.account.address
    ]);

    await food.write.grantRole([
      retailerRole,
      retailer.account.address
    ]);

    // Farmer creates Batch #1.
    await food.write.registerBatch([
      "Organic Tomatoes",
      "Green Farm",
      1n
    ]);

    // Deploy the new shipment contract locally.
    shipment = await viem.deployContract(
      "ShipmentIntegrity",
      [food.address]
    );

    // Connect different wallets to the shipment contract.
    farmerShipment = await viem.getContractAt(
      "ShipmentIntegrity",
      shipment.address,
      { client: { wallet: farmer } }
    );

    outsiderShipment = await viem.getContractAt(
      "ShipmentIntegrity",
      shipment.address,
      { client: { wallet: outsider } }
    );
  });

  it("allows the current holder to record a shipment", async () => {
    await farmerShipment.write.recordShipment([
      BATCH_ID,
      SHIPMENT_ID,
      HASH
    ]);

    const anchor = await shipment.read.getAnchor([
      BATCH_ID,
      SHIPMENT_ID
    ]);

    assert.equal(anchor[0], HASH);
    assert.equal(
      anchor[1].toLowerCase(),
      farmer.account.address.toLowerCase()
    );
    assert.ok(anchor[2] > 0n);
    assert.equal(anchor[3], true);
  });

  it("rejects an unauthorized wallet", async () => {
    await assert.rejects(
      outsiderShipment.write.recordShipment([
        BATCH_ID,
        SHIPMENT_ID,
        HASH
      ]),
      /Only current holder can record/
    );
  });

  it("rejects a nonexistent batch", async () => {
    await assert.rejects(
      farmerShipment.write.recordShipment([
        999n,
        SHIPMENT_ID,
        HASH
      ]),
      /Batch not found/
    );
  });

  it("rejects duplicate shipment IDs", async () => {
    await farmerShipment.write.recordShipment([
      BATCH_ID,
      SHIPMENT_ID,
      HASH
    ]);

    await assert.rejects(
      farmerShipment.write.recordShipment([
        BATCH_ID,
        SHIPMENT_ID,
        WRONG_HASH
      ]),
      /Shipment already anchored/
    );
  });

  it("verifies the correct SHA-256 hash", async () => {
    await farmerShipment.write.recordShipment([
      BATCH_ID,
      SHIPMENT_ID,
      HASH
    ]);

    const verified = await shipment.read.verifyShipment([
      BATCH_ID,
      SHIPMENT_ID,
      HASH
    ]);

    assert.equal(verified, true);
  });

  it("rejects a modified shipment hash", async () => {
    await farmerShipment.write.recordShipment([
      BATCH_ID,
      SHIPMENT_ID,
      HASH
    ]);

    const verified = await shipment.read.verifyShipment([
      BATCH_ID,
      SHIPMENT_ID,
      WRONG_HASH
    ]);

    assert.equal(verified, false);
  });

  it("rejects an empty shipment hash", async () => {
    const emptyHash =
      `0x${"00".repeat(32)}` as `0x${string}`;

    await assert.rejects(
      farmerShipment.write.recordShipment([
        BATCH_ID,
        SHIPMENT_ID,
        emptyHash
      ]),
      /Empty shipment hash/
    );
  });

  it("preserves verification after ownership transfer", async () => {
    await farmerShipment.write.recordShipment([
      BATCH_ID,
      SHIPMENT_ID,
      HASH
    ]);

    // Farmer transfers the batch to Distributor.
    await food.write.transferBatch(
      [BATCH_ID, distributor.account.address],
      { account: farmer.account }
    );

    // Original shipment must still be verifiable.
    const verified = await shipment.read.verifyShipment([
      BATCH_ID,
      SHIPMENT_ID,
      HASH
    ]);

    assert.equal(verified, true);

    // Previous holder cannot anchor a new shipment.
    await assert.rejects(
      farmerShipment.write.recordShipment([
        BATCH_ID,
        "SHIP-002",
        HASH
      ]),
      /Only current holder can record/
    );

    // The new holder can record the next shipment.
    const distributorShipment = await viem.getContractAt(
      "ShipmentIntegrity",
      shipment.address,
      { client: { wallet: distributor } }
    );

    await distributorShipment.write.recordShipment([
      BATCH_ID,
      "SHIP-002",
      digest("Distributor shipment")
    ]);

    const secondAnchor = await shipment.read.getAnchor([
      BATCH_ID,
      "SHIP-002"
    ]);

    assert.equal(secondAnchor[3], true);
    assert.equal(
      secondAnchor[1].toLowerCase(),
      distributor.account.address.toLowerCase()
    );
  });

  it("rejects an empty shipment ID", async () => {
    await assert.rejects(
      farmerShipment.write.recordShipment([
        BATCH_ID,
        "",
        HASH
      ]),
      /Shipment ID required/
    );
  });

  it("returns false for a shipment that was never recorded", async () => {
    const verified = await shipment.read.verifyShipment([
      BATCH_ID,
      "UNKNOWN-SHIPMENT",
      HASH
    ]);

    assert.equal(verified, false);
  });
});
