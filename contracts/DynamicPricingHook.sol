// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { IReputationRegistry } from "./interfaces/INexarCondition.sol";

/// @title DynamicPricingHook
/// @notice Implements ILicensingHook to dynamically price license token minting.
///
/// Pricing formula:
///   totalFee = basePrice[ipId] * demandMultiplier * tierMultiplier / reputationDiscount
///
/// Where:
///   demandMultiplier = 1 + (demandCount[ipId] / DEMAND_STEP)
///   tierMultiplier   = 1x (DATASET), 2x (MODEL), 3x (STRATEGY), 5x (INFERENCE)
///   reputationDiscount = 1 - (reputation / 200)  → up to 50% discount at rep=100
///
/// This creates emergent market dynamics:
///   - Popular assets cost more (demand pricing)
///   - High-value asset types cost more (tier pricing)
///   - Trusted agents pay less (reputation discount)
///   - Revenue flows correctly because fee returns to LicensingModule → Royalty Module

interface ILicensingHook {
    function beforeMintLicenseTokens(
        address caller,
        address licensorIpId,
        address licenseTemplate,
        uint256 licenseTermsId,
        uint256 amount,
        address receiver,
        bytes calldata hookData
    ) external returns (uint256 totalMintingFee);
}

contract DynamicPricingHook is ILicensingHook {
    // ─── Asset tier enum ─────────────────────────────────────────────────────
    // 0 = DATASET, 1 = MODEL, 2 = STRATEGY, 3 = INFERENCE
    uint8 public constant TIER_DATASET   = 0;
    uint8 public constant TIER_MODEL     = 1;
    uint8 public constant TIER_STRATEGY  = 2;
    uint8 public constant TIER_INFERENCE = 3;

    // Tier multipliers (in basis points, 10000 = 1x)
    uint256[4] public tierMultiplierBps = [10000, 20000, 30000, 50000];

    // Demand scaling: every DEMAND_STEP licenses, price increases by 10%
    uint256 public constant DEMAND_STEP = 10;

    // ─── State ───────────────────────────────────────────────────────────────

    /// @dev Base price per IP (in WIP, 18 decimals). Set by IP owner via setBasePrice.
    mapping(address => uint256) public basePrice;

    /// @dev Asset tier per IP. Set by IP owner.
    mapping(address => uint8) public assetTier;

    /// @dev How many times each IP has been licensed (demand counter)
    mapping(address => uint256) public demandCount;

    /// @dev IP owner registry (ipId => owner). Set when IP registers with this hook.
    mapping(address => address) public ipOwner;

    /// @dev Reputation registry contract
    IReputationRegistry public immutable reputationRegistry;

    address public owner;

    // ─── Events ──────────────────────────────────────────────────────────────

    event AssetRegistered(address indexed ipId, uint8 tier, uint256 basePrice, address owner);
    event LicensePriced(address indexed ipId, address indexed caller, uint256 finalFee, uint256 demandCount);
    event BasePriceUpdated(address indexed ipId, uint256 newBasePrice);

    // ─── Constructor ─────────────────────────────────────────────────────────

    constructor(address _reputationRegistry) {
        reputationRegistry = IReputationRegistry(_reputationRegistry);
        owner = msg.sender;
    }

    // ─── IP Owner Configuration ───────────────────────────────────────────────

    /// @notice Register an IP with this hook. Called by ProviderAgent after IP registration.
    /// @param ipId The Story Protocol IP Asset ID
    /// @param tier Asset tier (0=DATASET, 1=MODEL, 2=STRATEGY, 3=INFERENCE)
    /// @param _basePrice Base minting fee in WIP (18 decimals)
    function registerAsset(address ipId, uint8 tier, uint256 _basePrice) external {
        require(tier <= TIER_INFERENCE, "DynamicPricingHook: invalid tier");
        assetTier[ipId] = tier;
        basePrice[ipId] = _basePrice;
        ipOwner[ipId] = msg.sender;
        emit AssetRegistered(ipId, tier, _basePrice, msg.sender);
    }

    /// @notice Update base price for an IP (owner only)
    function setBasePrice(address ipId, uint256 _basePrice) external {
        require(msg.sender == ipOwner[ipId] || msg.sender == owner, "DynamicPricingHook: not owner");
        basePrice[ipId] = _basePrice;
        emit BasePriceUpdated(ipId, _basePrice);
    }

    // ─── ILicensingHook Implementation ───────────────────────────────────────

    /// @notice Called by LicensingModule before minting license tokens.
    ///         Returns the dynamic total minting fee.
    function beforeMintLicenseTokens(
        address caller,
        address licensorIpId,
        address /*licenseTemplate*/,
        uint256 /*licenseTermsId*/,
        uint256 amount,
        address /*receiver*/,
        bytes calldata /*hookData*/
    ) external override returns (uint256 totalMintingFee) {
        uint256 base = basePrice[licensorIpId];

        // If no base price configured, use zero (free)
        if (base == 0) return 0;

        // 1. Demand multiplier: price increases 10% per DEMAND_STEP licenses
        uint256 demand = demandCount[licensorIpId];
        uint256 demandIncreaseBps = (demand / DEMAND_STEP) * 1000; // 10% per step
        uint256 demandMultipliedBps = 10000 + demandIncreaseBps;   // base 1x + increase

        // 2. Tier multiplier
        uint8 tier = assetTier[licensorIpId];
        uint256 tierBps = tierMultiplierBps[tier];

        // 3. Reputation discount: reputation 0–100 → 0%–50% discount
        uint256 reputation = reputationRegistry.getReputation(caller);
        // discountBps = reputation * 50 (i.e. rep=100 → 5000bps = 50%)
        uint256 discountBps = reputation * 50;
        uint256 discountDivisorBps = 10000 - discountBps; // e.g. rep=100 → 5000

        // 4. Compose: base * demandMultiplier * tierMultiplier / 1e8 / reputationFactor
        uint256 pricePerUnit = (base * demandMultipliedBps / 10000)
                                    * tierBps / 10000
                                    * discountDivisorBps / 10000;

        totalMintingFee = pricePerUnit * amount;

        // 5. Record demand increase and reputation
        demandCount[licensorIpId] += amount;
        try reputationRegistry.recordLicensePurchase(caller) {} catch {}

        emit LicensePriced(licensorIpId, caller, totalMintingFee, demandCount[licensorIpId]);

        return totalMintingFee;
    }

    // ─── View Helpers ────────────────────────────────────────────────────────

    /// @notice Preview what an agent would pay to mint `amount` licenses for `ipId`
    function previewPrice(
        address ipId,
        address caller,
        uint256 amount
    ) external view returns (uint256 estimatedFee) {
        uint256 base = basePrice[ipId];
        if (base == 0) return 0;

        uint256 demand = demandCount[ipId];
        uint256 demandMultipliedBps = 10000 + (demand / DEMAND_STEP) * 1000;
        uint256 tierBps = tierMultiplierBps[assetTier[ipId]];
        uint256 reputation = reputationRegistry.getReputation(caller);
        uint256 discountDivisorBps = 10000 - (reputation * 50);

        uint256 pricePerUnit = (base * demandMultipliedBps / 10000)
                                    * tierBps / 10000
                                    * discountDivisorBps / 10000;
        return pricePerUnit * amount;
    }

    /// @notice Get human-readable asset info
    function getAssetInfo(address ipId) external view returns (
        uint8 tier,
        uint256 base,
        uint256 demand,
        address ipOwnerAddr
    ) {
        return (assetTier[ipId], basePrice[ipId], demandCount[ipId], ipOwner[ipId]);
    }
}
