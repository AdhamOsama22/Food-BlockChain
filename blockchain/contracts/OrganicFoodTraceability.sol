
 // SPDX-License-Identifier: MIT
 pragma solidity ^0.8.24;

 import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

 contract OrganicFoodTraceability is AccessControl {
     bytes32 public constant FARMER_ROLE = keccak256("FARMER_ROLE");
     bytes32 public constant CERTIFIER_ROLE = keccak256("CERTIFIER_ROLE");
     bytes32 public constant DISTRIBUTOR_ROLE = keccak256("DISTRIBUTOR_ROLE");
     bytes32 public constant RETAILER_ROLE = keccak256("RETAILER_ROLE");

     enum BatchStage {
         Farm,
         Distributor,
         Retailer
     }

     struct FoodBatch {
         string productName;
         string farmName;
         uint256 harvestDate;
         address farmer;
         address currentHolder;
         bool exists;
         BatchStage stage;
     }

     struct Certificate {
         string certificateNumber;
         string ipfsCid;
         bytes32 fileHash;
         uint256 issueDate;
         uint256 expiryDate;
         address certifier;
         bool exists;
         bool revoked;
     }

     mapping(uint256 => FoodBatch) public batches;
     mapping(uint256 => Certificate) private certificates;

     uint256 public nextBatchId = 1;

     event BatchRegistered(
         uint256 indexed batchId,
         address indexed farmer,
         string productName
     );

     event BatchTransferred(
         uint256 indexed batchId,
         address indexed from,
         address indexed to,
         BatchStage newStage
     );

     event CertificateRegistered(
         uint256 indexed batchId,
         address indexed certifier,
         string certificateNumber
     );

     event CertificateRevoked(
         uint256 indexed batchId,
         address indexed revokedBy
     );

     constructor() {
         _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
     }

     function registerBatch(
         string memory productName,
         string memory farmName,
         uint256 harvestDate
     ) public onlyRole(FARMER_ROLE) returns (uint256) {
         require(bytes(productName).length > 0, "Product name required");
         require(bytes(farmName).length > 0, "Farm name required");
         require(harvestDate > 0, "Invalid harvest date");
         require(harvestDate <= block.timestamp, "Harvest date is in the future");

         uint256 batchId = nextBatchId;
         nextBatchId++;

         batches[batchId] = FoodBatch({
             productName: productName,
             farmName: farmName,
             harvestDate: harvestDate,
             farmer: msg.sender,
             currentHolder: msg.sender,
             exists: true,
             stage: BatchStage.Farm
         });

         emit BatchRegistered(batchId, msg.sender, productName);
         return batchId;
     }

     function transferBatch(uint256 batchId, address newHolder) public {
         FoodBatch storage batch = batches[batchId];

         require(batch.exists, "Batch does not exist");
         require(msg.sender == batch.currentHolder, "Not the current holder");
         require(newHolder != address(0), "Invalid recipient");
         require(newHolder != msg.sender, "Cannot transfer to yourself");

         BatchStage newStage = batch.stage;

         if (batch.stage == BatchStage.Farm) {
             require(hasRole(FARMER_ROLE, msg.sender), "Sender is not a farmer");
             require(
                 hasRole(DISTRIBUTOR_ROLE, newHolder),
                 "Recipient is not a distributor"
             );

             newStage = BatchStage.Distributor;
         } else if (batch.stage == BatchStage.Distributor) {
             require(
                 hasRole(DISTRIBUTOR_ROLE, msg.sender),
                 "Sender is not a distributor"
             );
             require(
                 hasRole(RETAILER_ROLE, newHolder),
                 "Recipient is not a retailer"
             );

             newStage = BatchStage.Retailer;
         } else {
             revert("Batch already reached retailer");
         }

         address previousHolder = batch.currentHolder;

         batch.currentHolder = newHolder;
         batch.stage = newStage;

         emit BatchTransferred(
             batchId,
             previousHolder,
             newHolder,
             newStage
         );
     }

     function registerCertificate(
         uint256 batchId,
         string memory certificateNumber,
         string memory ipfsCid,
         bytes32 fileHash,
         uint256 issueDate,
         uint256 expiryDate
     ) public onlyRole(CERTIFIER_ROLE) {
         require(batches[batchId].exists, "Batch does not exist");
         require(!certificates[batchId].exists, "Certificate already registered");
         require(bytes(certificateNumber).length > 0, "Certificate number required");
         require(bytes(ipfsCid).length > 0, "IPFS CID required");
         require(fileHash != bytes32(0), "Invalid file hash");
         require(issueDate > 0, "Invalid issue date");
         require(issueDate <= block.timestamp, "Issue date is in the future");
         require(expiryDate > block.timestamp, "Certificate already expired");

         certificates[batchId] = Certificate({
             certificateNumber: certificateNumber,
             ipfsCid: ipfsCid,
             fileHash: fileHash,
             issueDate: issueDate,
             expiryDate: expiryDate,
             certifier: msg.sender,
             exists: true,
             revoked: false
         });

         emit CertificateRegistered(
             batchId,
             msg.sender,
             certificateNumber
         );
     }

     function getCertificate(uint256 batchId)
         public
         view
         returns (Certificate memory)
     {
         require(certificates[batchId].exists, "Certificate does not exist");
         return certificates[batchId];
     }

     function isCertificateValid(uint256 batchId)
         public
         view
         returns (bool)
     {
         Certificate storage certificate = certificates[batchId];

         return (
             certificate.exists &&
             !certificate.revoked &&
             certificate.expiryDate > block.timestamp &&
             hasRole(CERTIFIER_ROLE, certificate.certifier)
         );
     }

     function revokeCertificate(uint256 batchId) public {
         Certificate storage certificate = certificates[batchId];

         require(certificate.exists, "Certificate does not exist");
         require(!certificate.revoked, "Certificate already revoked");
         require(
             msg.sender == certificate.certifier ||
             hasRole(DEFAULT_ADMIN_ROLE, msg.sender),
             "Not authorised to revoke"
         );

         certificate.revoked = true;

         emit CertificateRevoked(batchId, msg.sender);
     }

     function getBatch(uint256 batchId)
         public
         view
         returns (FoodBatch memory)
     {
         require(batches[batchId].exists, "Batch does not exist");
         return batches[batchId];
     }
 }
