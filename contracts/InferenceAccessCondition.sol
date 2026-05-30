// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { ILicenseToken } from "./interfaces/INexarCondition.sol";

/// @title InferenceAccessCondition
/// @notice Custom CDR read/write condition that enforces inference-only access.
///
/// Write condition: only the IP owner can write to the vault (same as OwnerWriteCondition).
/// Read condition: caller must:
///   1. Hold a valid license token for the target IP with the INFERENCE license terms ID
///   2. Not have exceeded their compute quota for this vault
///
/// This is the core mechanism that enables the "confidential inference market":
/// callers purchase inference rights (not data rights), access vault output only via
/// their derivative IP registration — they never see raw data or model weights.
///
/// CDR interface: implements checkWriteCondition + checkReadCondition
/// These are called by the CDR Core contract when validating vault operations.

contract InferenceAccessCondition {
    // ─── CDR Condition Interface ─────────────────────────────────────────────
    // CDR calls these functions. They must revert to deny access.

    /// @notice Called by CDR to check write permission
    /// @param caller Who is trying to write
    /// @param conditionData ABI-encoded owner address: abi.encode(address owner)
    function checkWriteCondition(
        address caller,
        bytes calldata conditionData
    ) external view {
        address allowedOwner = abi.decode(conditionData, (address));
        require(caller == allowedOwner, "InferenceAccessCondition: not vault owner");
    }

    /// @notice Called by CDR to check read permission
    /// @param caller Who is trying to read/decrypt
    /// @param conditionData ABI-encoded (licenseTokenAddr, ipId, inferenceLicenseTermsId, maxComputeUnits)
    /// @param accessAuxData ABI-encoded license token IDs caller is presenting: abi.encode(uint256[] tokenIds)
    function checkReadCondition(
        address caller,
        bytes calldata conditionData,
        bytes calldata accessAuxData
    ) external {
        (
            address licenseTokenAddr,
            address ipId,
            uint256 inferenceLicenseTermsId,
            uint256 maxComputeUnits
        ) = abi.decode(conditionData, (address, address, uint256, uint256));

        uint256[] memory tokenIds = abi.decode(accessAuxData, (uint256[]));
        require(tokenIds.length > 0, "InferenceAccessCondition: no license tokens provided");

        ILicenseToken licenseToken = ILicenseToken(licenseTokenAddr);

        // Verify at least one presented token is:
        // 1. Owned by the caller
        // 2. For the correct IP (licensorIpId == ipId)
        // 3. Has the INFERENCE license terms ID
        bool validTokenFound = false;
        for (uint256 i = 0; i < tokenIds.length; i++) {
            try licenseToken.ownerOf(tokenIds[i]) returns (address tokenOwner) {
                if (tokenOwner != caller) continue;

                try licenseToken.getLicensorIpId(tokenIds[i]) returns (address licensor) {
                    if (licensor != ipId) continue;
                } catch { continue; }

                try licenseToken.getLicenseTermsId(tokenIds[i]) returns (uint256 termsId) {
                    if (termsId == inferenceLicenseTermsId) {
                        validTokenFound = true;
                        break;
                    }
                } catch { continue; }
            } catch { continue; }
        }

        require(validTokenFound, "InferenceAccessCondition: no valid inference license token");

        // Check compute quota (key: keccak256(caller, ipId))
        bytes32 quotaKey = keccak256(abi.encodePacked(caller, ipId));
        uint256 used = _computeUsed[quotaKey];
        require(used < maxComputeUnits, "InferenceAccessCondition: compute quota exceeded");

        // Increment quota (this call mutates state — CDR calls this non-view)
        _computeUsed[quotaKey]++;
    }

    // ─── State ───────────────────────────────────────────────────────────────

    /// @dev Compute units used per (caller, ipId) pair
    mapping(bytes32 => uint256) private _computeUsed;

    address public owner;

    constructor() {
        owner = msg.sender;
    }

    // ─── Queries ─────────────────────────────────────────────────────────────

    /// @notice Check how many compute units a caller has used for an IP
    function getComputeUsed(address caller, address ipId) external view returns (uint256) {
        return _computeUsed[keccak256(abi.encodePacked(caller, ipId))];
    }

    /// @notice Reset compute quota for a caller/IP pair (owner only, for testing)
    function resetQuota(address caller, address ipId) external {
        require(msg.sender == owner, "InferenceAccessCondition: not owner");
        _computeUsed[keccak256(abi.encodePacked(caller, ipId))] = 0;
    }

    // ─── Condition Data Encoder (view helper) ────────────────────────────────

    /// @notice Encode conditionData for use with uploadCDR readConditionData
    function encodeConditionData(
        address licenseTokenAddr,
        address ipId,
        uint256 inferenceLicenseTermsId,
        uint256 maxComputeUnits
    ) external pure returns (bytes memory) {
        return abi.encode(licenseTokenAddr, ipId, inferenceLicenseTermsId, maxComputeUnits);
    }

    /// @notice Encode accessAuxData for use with accessCDR
    function encodeAccessAuxData(uint256[] calldata tokenIds) external pure returns (bytes memory) {
        return abi.encode(tokenIds);
    }
}
