// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title ReputationRegistry
/// @notice On-chain reputation tracking for agents in the NEXAR intelligence graph.
///         Reputation is used by DynamicPricingHook to discount minting fees for
///         high-reputation agents, creating a flywheel: license → build → earn → cheaper access.
contract ReputationRegistry {
    // ─── State ───────────────────────────────────────────────────────────────

    /// @dev Raw reputation points per agent (uncapped accumulation)
    mapping(address => uint256) private _points;

    /// @dev Total economic activity (WIP-equivalent, 18 decimals) routed through agent
    mapping(address => uint256) public totalVolumeRouted;

    /// @dev Number of license purchases per agent
    mapping(address => uint256) public licensesPurchased;

    /// @dev Number of derivative IPs registered by agent
    mapping(address => uint256) public derivativesRegistered;

    /// @dev Authorized callers that can write reputation (hook contracts, etc.)
    mapping(address => bool) public authorizedRecorders;

    address public owner;

    // ─── Events ──────────────────────────────────────────────────────────────

    event ReputationRecorded(address indexed agent, string action, uint256 pointsAdded, uint256 newTotal);
    event RecorderAuthorized(address indexed recorder, bool status);

    // ─── Modifiers ───────────────────────────────────────────────────────────

    modifier onlyOwner() {
        require(msg.sender == owner, "ReputationRegistry: not owner");
        _;
    }

    modifier onlyRecorder() {
        require(
            authorizedRecorders[msg.sender] || msg.sender == owner,
            "ReputationRegistry: not authorized"
        );
        _;
    }

    // ─── Constructor ─────────────────────────────────────────────────────────

    constructor() {
        owner = msg.sender;
        authorizedRecorders[msg.sender] = true;
    }

    // ─── Admin ───────────────────────────────────────────────────────────────

    function setRecorder(address recorder, bool status) external onlyOwner {
        authorizedRecorders[recorder] = status;
        emit RecorderAuthorized(recorder, status);
    }

    // ─── Recording functions (called by hook / agents) ───────────────────────

    /// @notice Record that an agent purchased a license. +5 points.
    function recordLicensePurchase(address agent) external onlyRecorder {
        _points[agent] += 5;
        licensesPurchased[agent]++;
        emit ReputationRecorded(agent, "LICENSE_PURCHASE", 5, _points[agent]);
    }

    /// @notice Record that an agent registered a derivative IP. +10 points.
    function recordDerivativeRegistered(address agent) external onlyRecorder {
        _points[agent] += 10;
        derivativesRegistered[agent]++;
        emit ReputationRecorded(agent, "DERIVATIVE_REGISTERED", 10, _points[agent]);
    }

    /// @notice Record royalty payment volume. Points scale with WIP amount (1 point per 0.1 WIP).
    /// @param agent The agent routing royalties
    /// @param amountWIP Amount in WIP (18 decimals)
    function recordRoyaltyPaid(address agent, uint256 amountWIP) external onlyRecorder {
        uint256 points = amountWIP / 1e17; // 1 point per 0.1 WIP
        if (points > 0) {
            _points[agent] += points;
            totalVolumeRouted[agent] += amountWIP;
            emit ReputationRecorded(agent, "ROYALTY_PAID", points, _points[agent]);
        }
    }

    /// @notice Manually grant reputation (owner only, for bootstrapping)
    function grantReputation(address agent, uint256 points) external onlyOwner {
        _points[agent] += points;
        emit ReputationRecorded(agent, "MANUAL_GRANT", points, _points[agent]);
    }

    // ─── Queries ─────────────────────────────────────────────────────────────

    /// @notice Returns reputation score capped at 100 (for use in pricing)
    /// @param agent The agent address
    /// @return score 0–100, where 100 = maximum discount tier
    function getReputation(address agent) external view returns (uint256 score) {
        uint256 pts = _points[agent];
        // Logarithmic scaling: 0 pts=0, 10 pts=33, 50 pts=66, 100+ pts=100
        if (pts == 0) return 0;
        if (pts >= 100) return 100;
        // Linear for simplicity on-chain: score = min(pts, 100)
        return pts > 100 ? 100 : pts;
    }

    /// @notice Returns raw points (uncapped, for display)
    function getRawPoints(address agent) external view returns (uint256) {
        return _points[agent];
    }
}
