// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @notice Read-only compatibility with the EXISTING deployed OrganicFoodTraceability.
interface IExistingOrganicTrace {
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

/// @notice Add a genuine, append-only, on-chain Processing stage without replacing
/// the existing Sepolia traceability contract or resetting previous batch IDs.
/// This is a COMPANION contract, not an upgrade to the original contract.
contract OrganicTraceProcessing is AccessControl {
    bytes32 public constant PROCESSOR_ROLE = keccak256("PROCESSOR_ROLE");
    IExistingOrganicTrace public immutable foodTraceability;

    struct ProcessingRecord {
        address processor;
        uint256 receivedQuantityKg;
        uint256 processingDate;
        string processingMethod;
        uint256 recordedAt;
        uint256 recordedBlock;
        bool exists;
    }

    mapping(uint256 => address) public assignedProcessor;
    mapping(uint256 => ProcessingRecord) private _processing;

    event ProcessorAssigned(uint256 indexed batchId, address indexed farmer, address indexed processor);
    event ProcessingRecorded(
        uint256 indexed batchId,
        address indexed processor,
        uint256 receivedQuantityKg,
        uint256 processingDate,
        string processingMethod
    );

    constructor(address existingFoodContract) {
        require(existingFoodContract.code.length > 0, "Not a deployed main contract");
        foodTraceability = IExistingOrganicTrace(existingFoodContract);
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    /// @notice Only the original farmer may nominate a processing facility.
    /// Must be assigned before the product leaves the Farmer stage.
    function assignProcessor(uint256 batchId, address processor) external {
        (, , , address farmer, , bool exists, uint8 stage) = foodTraceability.batches(batchId);
        require(exists, "Batch does not exist");
        require(msg.sender == farmer, "Only original farmer");
        require(stage == 0, "Batch has left Farmer stage");
        require(processor != address(0), "Invalid processor");
        require(hasRole(PROCESSOR_ROLE, processor), "Not an approved processor");
        require(!_processing[batchId].exists, "Processing already recorded");
        assignedProcessor[batchId] = processor;
        emit ProcessorAssigned(batchId, msg.sender, processor);
    }

    /// @notice A specifically assigned, Admin-approved Processor creates the record.
    /// No overwrite is possible. Does not transfer the original batch's custody.
    function recordProcessing(
        uint256 batchId,
        uint256 receivedQuantityKg,
        uint256 processingDate,
        string calldata processingMethod
    ) external onlyRole(PROCESSOR_ROLE) {
        (, , uint256 harvestDate, , , bool exists, uint8 stage) = foodTraceability.batches(batchId);
        require(exists, "Batch does not exist");
        require(stage == 0, "Batch has left Farmer stage");
        require(assignedProcessor[batchId] == msg.sender, "Processor not assigned to this batch");
        require(!_processing[batchId].exists, "Processing already recorded");
        require(receivedQuantityKg > 0, "Quantity must be positive");
        require(processingDate >= harvestDate && processingDate <= block.timestamp, "Invalid processing date");
        require(bytes(processingMethod).length > 0 && bytes(processingMethod).length <= 200, "Invalid processing method");

        _processing[batchId] = ProcessingRecord({
            processor: msg.sender,
            receivedQuantityKg: receivedQuantityKg,
            processingDate: processingDate,
            processingMethod: processingMethod,
            recordedAt: block.timestamp,
            recordedBlock: block.number,
            exists: true
        });
        emit ProcessingRecorded(batchId, msg.sender, receivedQuantityKg, processingDate, processingMethod);
    }

    function getProcessing(uint256 batchId) external view returns (ProcessingRecord memory) {
        return _processing[batchId];
    }
}
