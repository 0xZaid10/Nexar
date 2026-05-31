// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { ILicenseToken } from "./interfaces/INexarCondition.sol";

/// @title TimedAccessCondition
/// @notice CDR read/write condition that enforces time-limited access at the protocol level.
///
/// This contract solves the core limitation of the application-layer session TTL:
/// previously, the 48h NDA access window was only enforced by NEXAR's SessionManager
/// (off-chain JWT expiry). If someone bypassed the session layer, CDR would still
/// decrypt the vault as long as they held a license token.
///
/// With TimedAccessCondition, the expiry is enforced ON-CHAIN by the CDR validators
/// themselves. The vault becomes permanently inaccessible after the deadline — no
/// server or session manager involved. Pure protocol enforcement.
///
/// Write condition data: abi.encode(address owner)
/// Read condition data:  abi.encode(address licenseTokenAddr, address ipId, uint256 expiryTimestamp)
/// accessAuxData:        abi.encode(uint256[] licenseTokenIds)
///
/// Use cases:
///   - Film NDA: filmmaker shares rough cut for 48h — enforced at protocol level
///   - Time-limited dataset trial: 7 day access window
///   - Sprint-scoped strategy access: access expires end of trading session
///   - Any access that must have a hard protocol-level deadline

contract TimedAccessCondition {

    // ─── CDR Condition Interface ──────────────────────────────────────────────
    // CDR Core calls these. Revert = deny. Return = allow.

    /// @notice Called by CDR to check write permission.
    /// @param caller          Address attempting to write
    /// @param conditionData   abi.encode(address owner)
    function checkWriteCondition(
        address caller,
        bytes calldata conditionData
    ) external pure {
        address allowedOwner = abi.decode(conditionData, (address));
        require(caller == allowedOwner, "TimedAccessCondition: not vault owner");
    }

    /// @notice Called by CDR to check read permission.
    /// Enforces: (1) caller holds valid license, (2) current time < expiryTimestamp.
    ///
    /// @param caller          Address attempting to read/decrypt
    /// @param conditionData   abi.encode(address licenseTokenAddr, address ipId, uint256 expiryTimestamp)
    /// @param accessAuxData   abi.encode(uint256[] licenseTokenIds)
    function checkReadCondition(
        address caller,
        bytes calldata conditionData,
        bytes calldata accessAuxData
    ) external view {
        (
            address licenseTokenAddr,
            address ipId,
            uint256 expiryTimestamp
        ) = abi.decode(conditionData, (address, address, uint256));

        // ── 1. Check expiry ───────────────────────────────────────────────────
        // This is the core enforcement — protocol-level, no server involved.
        // After expiryTimestamp, this vault is permanently inaccessible.
        require(
            block.timestamp < expiryTimestamp,
            "TimedAccessCondition: access window has expired"
        );

        // ── 2. Check license token ownership ─────────────────────────────────
        uint256[] memory tokenIds = abi.decode(accessAuxData, (uint256[]));
        require(tokenIds.length > 0, "TimedAccessCondition: no license tokens provided");

        ILicenseToken licenseToken = ILicenseToken(licenseTokenAddr);

        bool validTokenFound = false;
        for (uint256 i = 0; i < tokenIds.length; i++) {
            try licenseToken.ownerOf(tokenIds[i]) returns (address tokenOwner) {
                if (tokenOwner != caller) continue;

                try licenseToken.getLicensorIpId(tokenIds[i]) returns (address licensor) {
                    if (licensor != ipId) continue;
                } catch { continue; }

                validTokenFound = true;
                break;
            } catch { continue; }
        }

        require(validTokenFound, "TimedAccessCondition: no valid license token for this IP");
    }

    // ─── Vault registry ───────────────────────────────────────────────────────
    // Track expiry per vault UUID for easy off-chain querying.
    // Not required for condition enforcement — just useful for UX.

    /// @dev vaultUuid → expiryTimestamp
    mapping(uint256 => uint256) public vaultExpiry;

    /// @dev vaultUuid → owner address
    mapping(uint256 => address) public vaultOwner;

    address public owner;

    event VaultRegistered(uint256 indexed vaultUuid, address indexed vaultOwner, uint256 expiryTimestamp);

    constructor() {
        owner = msg.sender;
    }

    /// @notice Register a vault's expiry for off-chain lookup.
    /// Called by the vault creator after uploadCDR() succeeds.
    /// Optional — condition enforcement does not depend on this.
    function registerVault(uint256 vaultUuid, uint256 expiryTimestamp) external {
        vaultOwner[vaultUuid]  = msg.sender;
        vaultExpiry[vaultUuid] = expiryTimestamp;
        emit VaultRegistered(vaultUuid, msg.sender, expiryTimestamp);
    }

    /// @notice Extend the expiry of a vault (owner only).
    /// Can only extend, not reduce — prevents owner from locking out a reviewer mid-session.
    function extendExpiry(uint256 vaultUuid, uint256 newExpiryTimestamp) external {
        require(msg.sender == vaultOwner[vaultUuid], "TimedAccessCondition: not vault owner");
        require(
            newExpiryTimestamp > vaultExpiry[vaultUuid],
            "TimedAccessCondition: can only extend, not reduce expiry"
        );
        vaultExpiry[vaultUuid] = newExpiryTimestamp;
    }

    /// @notice Check if a vault is still within its access window.
    function isAccessible(uint256 vaultUuid) external view returns (bool) {
        uint256 expiry = vaultExpiry[vaultUuid];
        if (expiry == 0) return true; // unregistered vault — no expiry tracked
        return block.timestamp < expiry;
    }

    /// @notice Time remaining in seconds (0 if expired or unregistered).
    function timeRemaining(uint256 vaultUuid) external view returns (uint256) {
        uint256 expiry = vaultExpiry[vaultUuid];
        if (expiry == 0 || block.timestamp >= expiry) return 0;
        return expiry - block.timestamp;
    }

    // ─── Condition Data Encoders (view helpers for TypeScript SDK) ────────────

    /// @notice Encode readConditionData for uploadCDR / TimedAccessCondition
    /// @param licenseTokenAddr  Story LicenseToken contract address
    /// @param ipId              Story IP Asset ID
    /// @param expiryTimestamp   Unix timestamp when access expires
    function encodeReadConditionData(
        address licenseTokenAddr,
        address ipId,
        uint256 expiryTimestamp
    ) external pure returns (bytes memory) {
        return abi.encode(licenseTokenAddr, ipId, expiryTimestamp);
    }

    /// @notice Encode writeConditionData
    function encodeWriteConditionData(address vaultOwnerAddr) external pure returns (bytes memory) {
        return abi.encode(vaultOwnerAddr);
    }

    /// @notice Encode accessAuxData (license token IDs to present at read time)
    function encodeAccessAuxData(uint256[] calldata tokenIds) external pure returns (bytes memory) {
        return abi.encode(tokenIds);
    }
}
