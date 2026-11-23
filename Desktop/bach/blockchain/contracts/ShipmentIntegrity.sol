// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * Standalone append-only integrity anchors for OrganicTrace shipment records.
 * Existing OrganicFoodTraceability and Processing contracts are unchanged.
 * The caller must be the current on-chain batch holder when anchoring.
 */
interface IOrganicTraceShipmentBatch {
    function batches(uint256 batchId) external view returns (
        string memory productName,
        string memory farmName,
        uint256 harvestDate,
        address farmer,
        address currentHolder,
        bool exists,
        uint8 stage
    );
}

contract ShipmentIntegrity {
    IOrganicTraceShipmentBatch public immutable foodTraceability;

    struct Anchor {
        bytes32 digest;
        address recordedBy;
        uint64 recordedAt;
        bool exists;
    }

    mapping(uint256 => mapping(bytes32 => Anchor)) private anchors;

    event ShipmentAnchored(
        uint256 indexed batchId,
        bytes32 indexed shipmentKey,
        bytes32 digest,
        address indexed recordedBy
    );

    constructor(address mainContract) {
        require(mainContract != address(0), "Invalid main contract");
        require(mainContract.code.length > 0, "Main contract not deployed");
        foodTraceability = IOrganicTraceShipmentBatch(mainContract);
    }

    function shipmentKey(string memory shipmentId) public pure returns (bytes32) {
        require(bytes(shipmentId).length != 0, "Shipment ID required");
        return keccak256(bytes(shipmentId));
    }

    function recordShipment(uint256 batchId, string calldata shipmentId, bytes32 digest) external {
        require(digest != bytes32(0), "Empty shipment hash");
        bytes32 key = shipmentKey(shipmentId);
        (,,,,address holder,bool exists,) = foodTraceability.batches(batchId);
        require(exists, "Batch not found");
        require(msg.sender == holder, "Only current holder can record");
        require(!anchors[batchId][key].exists, "Shipment already anchored");
        anchors[batchId][key] = Anchor({
            digest: digest,
            recordedBy: msg.sender,
            recordedAt: uint64(block.timestamp),
            exists: true
        });
        emit ShipmentAnchored(batchId, key, digest, msg.sender);
    }

    function getAnchor(uint256 batchId, string calldata shipmentId) external view returns (
        bytes32 digest, address recordedBy, uint64 recordedAt, bool exists
    ) {
        Anchor storage a = anchors[batchId][shipmentKey(shipmentId)];
        return (a.digest, a.recordedBy, a.recordedAt, a.exists);
    }

    function verifyShipment(uint256 batchId, string calldata shipmentId, bytes32 digest) external view returns (bool) {
        Anchor storage a = anchors[batchId][shipmentKey(shipmentId)];
        return a.exists && digest != bytes32(0) && a.digest == digest;
    }
}
