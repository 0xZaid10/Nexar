// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title INexarCondition — shared interfaces for NEXAR contracts

interface IReputationRegistry {
    function getReputation(address agent) external view returns (uint256 score);
    function recordLicensePurchase(address agent) external;
    function recordDerivativeRegistered(address agent) external;
    function recordRoyaltyPaid(address agent, uint256 amountWIP) external;
}

interface ILicenseToken {
    function ownerOf(uint256 tokenId) external view returns (address);
    function getLicenseTermsId(uint256 tokenId) external view returns (uint256);
    function getLicensorIpId(uint256 tokenId) external view returns (address);
}
