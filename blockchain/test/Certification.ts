
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import hre from "hardhat";

const { viem } = await hre.network.create();

describe("Organic food certificates", function () {
  const fileHash = `0x${"ab".repeat(32)}` as `0x${string}`;
  const zeroHash = `0x${"00".repeat(32)}` as `0x${string}`;
  const cid = "bafy-test-certificate-cid";

  async function setup() {
    const contract = await viem.deployContract("OrganicFoodTraceability");
    const [admin, farmer, certifier, outsider] =
      await viem.getWalletClients();

    const farmerRole = await contract.read.FARMER_ROLE();
    const certifierRole = await contract.read.CERTIFIER_ROLE();

    await contract.write.grantRole([farmerRole, farmer.account.address]);
    await contract.write.grantRole([certifierRole, certifier.account.address]);

    const publicClient = await viem.getPublicClient();
    const block = await publicClient.getBlock();

    const issueDate = block.timestamp - 86400n;
    const expiryDate = block.timestamp + 86400n * 365n;

    await contract.write.registerBatch(
      ["Organic Tomatoes", "Farm A", issueDate],
      { account: farmer.account }
    );

    const certificateData = [
      1n,
      "CERT-001",
      cid,
      fileHash,
      issueDate,
      expiryDate
    ] as const;

    return {
      contract,
      admin,
      certifier,
      outsider,
      certificateData
    };
  }

  it("allows an authorised certifier to register a certificate", async function () {
    const { contract, certifier, certificateData } = await setup();

    await contract.write.registerCertificate(
      certificateData,
      { account: certifier.account }
    );

    const certificate = await contract.read.getCertificate([1n]);

    assert.equal(certificate.certificateNumber, "CERT-001");
    assert.equal(certificate.ipfsCid, cid);
    assert.equal(certificate.fileHash, fileHash);
    assert.equal(certificate.exists, true);
    assert.equal(certificate.revoked, false);

    assert.equal(
      certificate.certifier.toLowerCase(),
      certifier.account.address.toLowerCase()
    );

    assert.equal(await contract.read.isCertificateValid([1n]), true);
  });

  it("rejects certificate registration by an unauthorised user", async function () {
    const { contract, outsider, certificateData } = await setup();

    await assert.rejects(
      contract.write.registerCertificate(
        certificateData,
        { account: outsider.account }
      )
    );
  });

  it("rejects a certificate for a nonexistent batch", async function () {
    const { contract, certifier, certificateData } = await setup();

    await viem.assertions.revertWith(
      contract.write.registerCertificate(
        [
          999n,
          certificateData[1],
          certificateData[2],
          certificateData[3],
          certificateData[4],
          certificateData[5]
        ],
        { account: certifier.account }
      ),
      "Batch does not exist"
    );
  });

  it("rejects duplicate certificates", async function () {
    const { contract, certifier, certificateData } = await setup();

    await contract.write.registerCertificate(
      certificateData,
      { account: certifier.account }
    );

    await viem.assertions.revertWith(
      contract.write.registerCertificate(
        certificateData,
        { account: certifier.account }
      ),
      "Certificate already registered"
    );
  });

  it("rejects an empty certificate number", async function () {
    const { contract, certifier, certificateData } = await setup();

    await viem.assertions.revertWith(
      contract.write.registerCertificate(
        [
          1n,
          "",
          certificateData[2],
          certificateData[3],
          certificateData[4],
          certificateData[5]
        ],
        { account: certifier.account }
      ),
      "Certificate number required"
    );
  });

  it("rejects an empty IPFS CID", async function () {
    const { contract, certifier, certificateData } = await setup();

    await viem.assertions.revertWith(
      contract.write.registerCertificate(
        [
          1n,
          "CERT-001",
          "",
          certificateData[3],
          certificateData[4],
          certificateData[5]
        ],
        { account: certifier.account }
      ),
      "IPFS CID required"
    );
  });

  it("rejects a zero file hash", async function () {
    const { contract, certifier, certificateData } = await setup();

    await viem.assertions.revertWith(
      contract.write.registerCertificate(
        [
          1n,
          "CERT-001",
          cid,
          zeroHash,
          certificateData[4],
          certificateData[5]
        ],
        { account: certifier.account }
      ),
      "Invalid file hash"
    );
  });

  it("rejects an expired certificate", async function () {
    const { contract, certifier, certificateData } = await setup();

    await viem.assertions.revertWith(
      contract.write.registerCertificate(
        [
          1n,
          "CERT-001",
          cid,
          fileHash,
          certificateData[4],
          certificateData[4] + 1n
        ],
        { account: certifier.account }
      ),
      "Certificate already expired"
    );
  });

  it("returns false when no certificate exists", async function () {
    const { contract } = await setup();

    assert.equal(
      await contract.read.isCertificateValid([1n]),
      false
    );
  });

  it("allows the issuing certifier to revoke a certificate", async function () {
    const { contract, certifier, certificateData } = await setup();

    await contract.write.registerCertificate(
      certificateData,
      { account: certifier.account }
    );

    await contract.write.revokeCertificate(
      [1n],
      { account: certifier.account }
    );

    const certificate = await contract.read.getCertificate([1n]);

    assert.equal(certificate.revoked, true);
    assert.equal(await contract.read.isCertificateValid([1n]), false);
  });

  it("rejects revocation by an unauthorised user", async function () {
    const { contract, certifier, outsider, certificateData } = await setup();

    await contract.write.registerCertificate(
      certificateData,
      { account: certifier.account }
    );

    await viem.assertions.revertWith(
      contract.write.revokeCertificate(
        [1n],
        { account: outsider.account }
      ),
      "Not authorised to revoke"
    );
  });

  it("allows the administrator to revoke a certificate", async function () {
    const { contract, certifier, admin, certificateData } = await setup();

    await contract.write.registerCertificate(
      certificateData,
      { account: certifier.account }
    );

    await contract.write.revokeCertificate(
      [1n],
      { account: admin.account }
    );

    assert.equal(await contract.read.isCertificateValid([1n]), false);
  });

  it("rejects revoking the same certificate twice", async function () {
    const { contract, certifier, certificateData } = await setup();

    await contract.write.registerCertificate(
      certificateData,
      { account: certifier.account }
    );

    await contract.write.revokeCertificate(
      [1n],
      { account: certifier.account }
    );

    await viem.assertions.revertWith(
      contract.write.revokeCertificate(
        [1n],
        { account: certifier.account }
      ),
      "Certificate already revoked"
    );
  });
});
