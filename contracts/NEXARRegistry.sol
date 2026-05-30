// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title NEXARRegistry
/// @notice On-chain registry that maps Story IP Assets to CDR vault UUIDs and
///         NEXAR asset metadata. Acts as the canonical index for the NEXAR
///         intelligence graph — any client can query this to discover assets,
///         their vault locations, their tier, and their owner.
///
/// @dev This contract is intentionally lightweight. It stores only the
///      pointers and metadata needed for discovery. All access control and
///      confidentiality enforcement happens in CDR Core + InferenceAccessCondition.
///
/// Relationship to other contracts:
///   NEXARRegistry ─── ipId ──→ Story IPAssetRegistry
///   NEXARRegistry ─── uuid ──→ CDR Core vault
///   NEXARRegistry ─── ipId ──→ DynamicPricingHook (tier + pricing)
///   NEXARRegistry ─── ipId ──→ ReputationRegistry (owner reputation)

contract NEXARRegistry {
    // ─── Asset tier (mirrors DynamicPricingHook.sol) ─────────────────────────
    uint8 public constant TIER_DATASET   = 0;
    uint8 public constant TIER_MODEL     = 1;
    uint8 public constant TIER_STRATEGY  = 2;
    uint8 public constant TIER_INFERENCE = 3;
    uint8 public constant TIER_PROMPT    = 4;

    // ─── Structs ─────────────────────────────────────────────────────────────

    struct AssetRecord {
        address ipId;          // Story IP Asset ID (= IP Account address)
        uint256 vaultUuid;     // CDR vault UUID
        uint8   tier;          // Asset tier (0–4)
        address owner;         // IP owner address
        uint256 registeredAt;  // block.timestamp at registration
        bool    active;        // false = delisted (vault still exists, just hidden)
        string  name;          // human-readable asset name
        string  assetType;     // "dataset" | "model" | "strategy" | "inference" | "prompt"
    }

    struct PoolRecord {
        address groupIpId;     // Story Group IP Asset ID
        uint256[] memberIds;   // internal asset IDs of members
        address owner;
        uint256 createdAt;
        bool    active;
        string  name;
    }

    // ─── State ───────────────────────────────────────────────────────────────

    /// @dev internal asset ID counter
    uint256 private _nextAssetId;

    /// @dev internal pool ID counter
    uint256 private _nextPoolId;

    /// @dev assetId → AssetRecord
    mapping(uint256 => AssetRecord) public assets;

    /// @dev poolId → PoolRecord
    mapping(uint256 => PoolRecord) public pools;

    /// @dev ipId → assetId (reverse lookup)
    mapping(address => uint256) public ipIdToAssetId;

    /// @dev vaultUuid → assetId (reverse lookup)
    mapping(uint256 => uint256) public uuidToAssetId;

    /// @dev owner → list of assetIds they registered
    mapping(address => uint256[]) public ownerAssets;

    /// @dev owner → list of poolIds they created
    mapping(address => uint256[]) public ownerPools;

    /// @dev tier → list of assetIds with that tier (for discovery)
    mapping(uint8 => uint256[]) public tierAssets;

    address public owner;

    // ─── Events ──────────────────────────────────────────────────────────────

    event AssetRegistered(
        uint256 indexed assetId,
        address indexed ipId,
        uint256 vaultUuid,
        uint8   tier,
        address owner,
        string  name
    );

    event AssetDelisted(uint256 indexed assetId, address indexed ipId);

    event PoolRegistered(
        uint256 indexed poolId,
        address indexed groupIpId,
        address owner,
        string  name
    );

    event MemberAdded(uint256 indexed poolId, uint256 indexed assetId);

    // ─── Constructor ─────────────────────────────────────────────────────────

    constructor() {
        owner = msg.sender;
        _nextAssetId = 1; // start from 1 so 0 = "not found" in reverse lookups
        _nextPoolId  = 1;
    }

    // ─── Asset Registration ───────────────────────────────────────────────────

    /// @notice Register an intelligence asset in NEXAR.
    /// @dev Called by AssetRegistry.ts after IP registration + CDR vault creation.
    /// @param ipId     Story IP Asset ID (returned by mintAndRegisterIp)
    /// @param vaultUuid CDR vault UUID (returned by uploadCDR / uploadFile)
    /// @param tier     Asset tier (use TIER_* constants)
    /// @param name     Human-readable asset name
    /// @param assetType Asset type string ("dataset", "model", etc.)
    /// @return assetId Internal NEXAR asset ID
    function registerAsset(
        address ipId,
        uint256 vaultUuid,
        uint8   tier,
        string  calldata name,
        string  calldata assetType
    ) external returns (uint256 assetId) {
        require(ipId != address(0), "NEXARRegistry: zero ipId");
        require(tier <= TIER_PROMPT, "NEXARRegistry: invalid tier");
        require(ipIdToAssetId[ipId] == 0, "NEXARRegistry: ipId already registered");
        require(uuidToAssetId[vaultUuid] == 0, "NEXARRegistry: vault already registered");
        require(bytes(name).length > 0, "NEXARRegistry: empty name");

        assetId = _nextAssetId++;

        assets[assetId] = AssetRecord({
            ipId:         ipId,
            vaultUuid:    vaultUuid,
            tier:         tier,
            owner:        msg.sender,
            registeredAt: block.timestamp,
            active:        true,
            name:          name,
            assetType:    assetType
        });

        ipIdToAssetId[ipId]          = assetId;
        uuidToAssetId[vaultUuid]     = assetId;
        ownerAssets[msg.sender].push(assetId);
        tierAssets[tier].push(assetId);

        emit AssetRegistered(assetId, ipId, vaultUuid, tier, msg.sender, name);
    }

    /// @notice Delist an asset (hide from discovery, vault still exists on-chain)
    function delistAsset(uint256 assetId) external {
        AssetRecord storage rec = assets[assetId];
        require(rec.owner == msg.sender || msg.sender == owner, "NEXARRegistry: not owner");
        require(rec.active, "NEXARRegistry: already delisted");
        rec.active = false;
        emit AssetDelisted(assetId, rec.ipId);
    }

    // ─── Pool Registration ────────────────────────────────────────────────────

    /// @notice Register a Group IP intelligence pool.
    /// @param groupIpId Story Group IP Asset ID
    /// @param name      Human-readable pool name
    /// @return poolId   Internal NEXAR pool ID
    function registerPool(
        address groupIpId,
        string  calldata name
    ) external returns (uint256 poolId) {
        require(groupIpId != address(0), "NEXARRegistry: zero groupIpId");
        require(bytes(name).length > 0, "NEXARRegistry: empty name");

        poolId = _nextPoolId++;

        pools[poolId] = PoolRecord({
            groupIpId:  groupIpId,
            memberIds:  new uint256[](0),
            owner:      msg.sender,
            createdAt:  block.timestamp,
            active:     true,
            name:       name
        });

        ownerPools[msg.sender].push(poolId);
        emit PoolRegistered(poolId, groupIpId, msg.sender, name);
    }

    /// @notice Add an asset to a pool (must be asset owner or pool owner)
    function addToPool(uint256 poolId, uint256 assetId) external {
        PoolRecord storage pool = pools[poolId];
        AssetRecord storage asset = assets[assetId];
        require(pool.active, "NEXARRegistry: pool not active");
        require(asset.active, "NEXARRegistry: asset not active");
        require(
            msg.sender == pool.owner || msg.sender == asset.owner,
            "NEXARRegistry: not authorized"
        );
        require(pool.memberIds.length < 1000, "NEXARRegistry: pool full (max 1000)");

        pool.memberIds.push(assetId);
        emit MemberAdded(poolId, assetId);
    }

    // ─── Discovery Queries ────────────────────────────────────────────────────

    /// @notice Get all active asset IDs for a given tier
    function getAssetsByTier(uint8 tier) external view returns (uint256[] memory) {
        uint256[] storage all = tierAssets[tier];
        // Count active
        uint256 count = 0;
        for (uint256 i = 0; i < all.length; i++) {
            if (assets[all[i]].active) count++;
        }
        uint256[] memory result = new uint256[](count);
        uint256 j = 0;
        for (uint256 i = 0; i < all.length; i++) {
            if (assets[all[i]].active) result[j++] = all[i];
        }
        return result;
    }

    /// @notice Get all assets owned by an address
    function getAssetsByOwner(address _owner) external view returns (uint256[] memory) {
        return ownerAssets[_owner];
    }

    /// @notice Get all pools owned by an address
    function getPoolsByOwner(address _owner) external view returns (uint256[] memory) {
        return ownerPools[_owner];
    }

    /// @notice Get pool members
    function getPoolMembers(uint256 poolId) external view returns (uint256[] memory) {
        return pools[poolId].memberIds;
    }

    /// @notice Get asset by ipId
    function getAssetByIpId(address ipId) external view returns (AssetRecord memory) {
        return assets[ipIdToAssetId[ipId]];
    }

    /// @notice Get asset by CDR vault UUID
    function getAssetByUuid(uint256 uuid) external view returns (AssetRecord memory) {
        return assets[uuidToAssetId[uuid]];
    }

    /// @notice Total registered assets
    function totalAssets() external view returns (uint256) {
        return _nextAssetId - 1;
    }

    /// @notice Total registered pools
    function totalPools() external view returns (uint256) {
        return _nextPoolId - 1;
    }
}
