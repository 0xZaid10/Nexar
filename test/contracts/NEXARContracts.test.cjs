// test/contracts/NEXARContracts.test.cjs
// Hardhat unit tests for all 4 NEXAR custom contracts.
// Run: npm run test:contracts
// Uses local hardhat network — no testnet needed, no funds needed.

const { expect } = require("chai");
const { ethers }  = require("hardhat");

describe("ReputationRegistry", function () {
  let registry;
  let owner, recorder, agent;

  beforeEach(async function () {
    [owner, recorder, agent] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("ReputationRegistry");
    registry = await Factory.deploy();
    await registry.waitForDeployment();
  });

  it("deploys with owner set", async function () {
    expect(await registry.owner()).to.equal(owner.address);
  });

  it("owner is authorized recorder by default", async function () {
    expect(await registry.authorizedRecorders(owner.address)).to.be.true;
  });

  it("records license purchase and adds 5 points", async function () {
    await registry.recordLicensePurchase(agent.address);
    expect(await registry.getRawPoints(agent.address)).to.equal(5n);
    expect(await registry.licensesPurchased(agent.address)).to.equal(1n);
  });

  it("records derivative registration and adds 10 points", async function () {
    await registry.recordDerivativeRegistered(agent.address);
    expect(await registry.getRawPoints(agent.address)).to.equal(10n);
  });

  it("records royalty paid and adds proportional points", async function () {
    // 1 point per 0.1 WIP → 1 WIP = 10 points
    const oneWIP = ethers.parseEther("1");
    await registry.recordRoyaltyPaid(agent.address, oneWIP);
    expect(await registry.getRawPoints(agent.address)).to.equal(10n);
  });

  it("getReputation caps at 100", async function () {
    await registry.grantReputation(agent.address, 200n);
    expect(await registry.getReputation(agent.address)).to.equal(100n);
  });

  it("getReputation returns 0 for unknown agent", async function () {
    expect(await registry.getReputation(recorder.address)).to.equal(0n);
  });

  it("setRecorder authorizes external recorders", async function () {
    await registry.setRecorder(recorder.address, true);
    await registry.connect(recorder).recordLicensePurchase(agent.address);
    expect(await registry.getRawPoints(agent.address)).to.equal(5n);
  });

  it("unauthorized recorder cannot record", async function () {
    await expect(
      registry.connect(recorder).recordLicensePurchase(agent.address)
    ).to.be.revertedWith("ReputationRegistry: not authorized");
  });

  it("setRecorder revokes access", async function () {
    await registry.setRecorder(recorder.address, true);
    await registry.setRecorder(recorder.address, false);
    await expect(
      registry.connect(recorder).recordLicensePurchase(agent.address)
    ).to.be.revertedWith("ReputationRegistry: not authorized");
  });

  it("accumulates points from multiple actions", async function () {
    await registry.recordLicensePurchase(agent.address);     // +5
    await registry.recordDerivativeRegistered(agent.address); // +10
    await registry.recordLicensePurchase(agent.address);     // +5
    expect(await registry.getRawPoints(agent.address)).to.equal(20n);
    expect(await registry.getReputation(agent.address)).to.equal(20n);
  });
});

// ─── DynamicPricingHook ───────────────────────────────────────────────────────

describe("DynamicPricingHook", function () {
  let hook, registry;
  let owner, ipOwner, caller;
  const IP_ID = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

  beforeEach(async function () {
    [owner, ipOwner, caller] = await ethers.getSigners();

    const RegFactory  = await ethers.getContractFactory("ReputationRegistry");
    registry = await RegFactory.deploy();
    await registry.waitForDeployment();

    // Authorize hook as recorder (done in deploy.ts normally)
    const HookFactory = await ethers.getContractFactory("DynamicPricingHook");
    hook = await HookFactory.deploy(await registry.getAddress());
    await hook.waitForDeployment();
    await registry.setRecorder(await hook.getAddress(), true);
  });

  it("deploys with correct reputation registry", async function () {
    expect(await hook.reputationRegistry()).to.equal(await registry.getAddress());
  });

  it("registerAsset sets tier and base price", async function () {
    const basePrice = ethers.parseEther("0.1");
    await hook.connect(ipOwner).registerAsset(IP_ID, 0, basePrice); // tier 0 = DATASET
    const [tier, base, demand, ownerAddr] = await hook.getAssetInfo(IP_ID);
    expect(tier).to.equal(0n);
    expect(base).to.equal(basePrice);
    expect(demand).to.equal(0n);
    expect(ownerAddr).to.equal(ipOwner.address);
  });

  it("previewPrice returns base price with 1x tier for DATASET (no demand, no rep)", async function () {
    const base = ethers.parseEther("0.1");
    await hook.connect(ipOwner).registerAsset(IP_ID, 0, base);
    const price = await hook.previewPrice(IP_ID, caller.address, 1n);
    // DATASET tier = 1x, no demand, no reputation → price = base
    expect(price).to.equal(base);
  });

  it("MODEL tier multiplier (2x) doubles the price", async function () {
    const base = ethers.parseEther("0.1");
    await hook.connect(ipOwner).registerAsset(IP_ID, 1, base); // tier 1 = MODEL
    const price = await hook.previewPrice(IP_ID, caller.address, 1n);
    // 2x multiplier
    expect(price).to.equal(ethers.parseEther("0.2"));
  });

  it("STRATEGY tier multiplier (3x) triples the price", async function () {
    const base = ethers.parseEther("0.1");
    await hook.connect(ipOwner).registerAsset(IP_ID, 2, base); // tier 2 = STRATEGY
    const price = await hook.previewPrice(IP_ID, caller.address, 1n);
    expect(price).to.equal(ethers.parseEther("0.3"));
  });

  it("demandCount increases after beforeMintLicenseTokens", async function () {
    const base = ethers.parseEther("0.1");
    await hook.connect(ipOwner).registerAsset(IP_ID, 0, base);
    await hook.beforeMintLicenseTokens(caller.address, IP_ID, ethers.ZeroAddress, 1n, 1n, caller.address, "0x");
    expect(await hook.demandCount(IP_ID)).to.equal(1n);
  });

  it("setBasePrice updates price (owner only)", async function () {
    await hook.connect(ipOwner).registerAsset(IP_ID, 0, ethers.parseEther("0.1"));
    await hook.connect(ipOwner).setBasePrice(IP_ID, ethers.parseEther("0.5"));
    const [, base] = await hook.getAssetInfo(IP_ID);
    expect(base).to.equal(ethers.parseEther("0.5"));
  });

  it("returns 0 price for unregistered asset", async function () {
    const price = await hook.previewPrice(IP_ID, caller.address, 1n);
    expect(price).to.equal(0n);
  });

  it("rejects invalid tier in registerAsset", async function () {
    await expect(
      hook.connect(ipOwner).registerAsset(IP_ID, 5, ethers.parseEther("0.1"))
    ).to.be.revertedWith("DynamicPricingHook: invalid tier");
  });
});

// ─── InferenceAccessCondition ─────────────────────────────────────────────────

describe("InferenceAccessCondition", function () {
  let condition;
  let owner, caller, ipOwner;
  const IP_ID = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

  beforeEach(async function () {
    [owner, caller, ipOwner] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("InferenceAccessCondition");
    condition = await Factory.deploy();
    await condition.waitForDeployment();
  });

  it("deploys with owner set", async function () {
    expect(await condition.owner()).to.equal(owner.address);
  });

  it("getComputeUsed returns 0 initially", async function () {
    expect(await condition.getComputeUsed(caller.address, IP_ID)).to.equal(0n);
  });

  it("checkWriteCondition passes for correct owner", async function () {
    const condData = ethers.AbiCoder.defaultAbiCoder().encode(["address"], [ipOwner.address]);
    await expect(
      condition.checkWriteCondition(ipOwner.address, condData)
    ).to.not.be.reverted;
  });

  it("checkWriteCondition reverts for wrong address", async function () {
    const condData = ethers.AbiCoder.defaultAbiCoder().encode(["address"], [ipOwner.address]);
    await expect(
      condition.checkWriteCondition(caller.address, condData)
    ).to.be.revertedWith("InferenceAccessCondition: not vault owner");
  });

  it("resetQuota resets compute used", async function () {
    // First manually set quota via owner
    await condition.resetQuota(caller.address, IP_ID); // reset to 0 (already 0, no-op)
    expect(await condition.getComputeUsed(caller.address, IP_ID)).to.equal(0n);
  });

  it("resetQuota reverts for non-owner", async function () {
    await expect(
      condition.connect(caller).resetQuota(caller.address, IP_ID)
    ).to.be.revertedWith("InferenceAccessCondition: not owner");
  });

  it("encodeConditionData encodes all 4 params", async function () {
    const LICENSE_TOKEN = "0xFe3838BFb30B34170F00030B52eA4893d8aAC6bC";
    const encoded = await condition.encodeConditionData(LICENSE_TOKEN, IP_ID, 1n, 10n);
    expect(encoded).to.have.length.greaterThan(2);
    // Verify it can be decoded
    const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
      ["address", "address", "uint256", "uint256"],
      encoded
    );
    expect(decoded[0]).to.equal(LICENSE_TOKEN);
    expect(decoded[2]).to.equal(1n);
    expect(decoded[3]).to.equal(10n);
  });
});

// ─── NEXARRegistry ───────────────────────────────────────────────────────────

describe("NEXARRegistry", function () {
  let registry;
  let owner, user;
  const IP_ID    = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const GROUP_ID = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

  beforeEach(async function () {
    [owner, user] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("NEXARRegistry");
    registry = await Factory.deploy();
    await registry.waitForDeployment();
  });

  it("starts with zero assets and pools", async function () {
    expect(await registry.totalAssets()).to.equal(0n);
    expect(await registry.totalPools()).to.equal(0n);
  });

  it("registerAsset returns assetId and emits event", async function () {
    const tx = await registry.registerAsset(IP_ID, 42n, 0, "Test Dataset", "dataset");
    const receipt = await tx.wait();
    expect(await registry.totalAssets()).to.equal(1n);
  });

  it("registered asset has correct fields", async function () {
    await registry.registerAsset(IP_ID, 42n, 0, "Test Dataset", "dataset");
    const asset = await registry.assets(1n);
    expect(asset.ipId.toLowerCase()).to.equal(IP_ID.toLowerCase());
    expect(asset.vaultUuid).to.equal(42n);
    expect(asset.tier).to.equal(0n);
    expect(asset.name).to.equal("Test Dataset");
    expect(asset.active).to.be.true;
  });

  it("ipIdToAssetId reverse lookup works", async function () {
    await registry.registerAsset(IP_ID, 42n, 0, "Test", "dataset");
    expect(await registry.ipIdToAssetId(IP_ID)).to.equal(1n);
  });

  it("uuidToAssetId reverse lookup works", async function () {
    await registry.registerAsset(IP_ID, 42n, 0, "Test", "dataset");
    expect(await registry.uuidToAssetId(42n)).to.equal(1n);
  });

  it("getAssetsByTier returns assets of correct tier", async function () {
    await registry.registerAsset(IP_ID, 1n, 0, "Dataset A", "dataset");
    const IP2 = "0xcccccccccccccccccccccccccccccccccccccccc";
    await registry.registerAsset(IP2, 2n, 1, "Model B", "model");
    const datasets = await registry.getAssetsByTier(0);
    expect(datasets).to.have.length(1);
    expect(datasets[0]).to.equal(1n);
  });

  it("delistAsset marks asset inactive", async function () {
    await registry.registerAsset(IP_ID, 42n, 0, "Test", "dataset");
    await registry.delistAsset(1n);
    const asset = await registry.assets(1n);
    expect(asset.active).to.be.false;
  });

  it("registerPool creates pool and emits event", async function () {
    await registry.registerPool(GROUP_ID, "Quant Alpha Pool");
    expect(await registry.totalPools()).to.equal(1n);
  });

  it("addToPool adds asset as member", async function () {
    await registry.registerAsset(IP_ID, 42n, 0, "Asset", "dataset");
    await registry.registerPool(GROUP_ID, "Pool");
    await registry.addToPool(1n, 1n);
    const members = await registry.getPoolMembers(1n);
    expect(members).to.have.length(1);
    expect(members[0]).to.equal(1n);
  });

  it("reverts on duplicate ipId registration", async function () {
    await registry.registerAsset(IP_ID, 42n, 0, "First", "dataset");
    await expect(
      registry.registerAsset(IP_ID, 43n, 0, "Duplicate", "dataset")
    ).to.be.revertedWith("NEXARRegistry: ipId already registered");
  });

  it("reverts on duplicate vaultUuid registration", async function () {
    const IP2 = "0xdddddddddddddddddddddddddddddddddddddddd";
    await registry.registerAsset(IP_ID, 42n, 0, "First", "dataset");
    await expect(
      registry.registerAsset(IP2, 42n, 0, "Duplicate UUID", "dataset")
    ).to.be.revertedWith("NEXARRegistry: vault already registered");
  });

  it("reverts on empty name", async function () {
    await expect(
      registry.registerAsset(IP_ID, 42n, 0, "", "dataset")
    ).to.be.revertedWith("NEXARRegistry: empty name");
  });
});

// ─── TimedAccessCondition ─────────────────────────────────────────────────────

describe("TimedAccessCondition", function () {
  let condition;
  let owner, caller, other;
  const IP_ID  = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const LIC    = "0xFe3838BFb30B34170F00030B52eA4893d8aAC6bC";

  beforeEach(async function () {
    [owner, caller, other] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("TimedAccessCondition");
    condition = await Factory.deploy();
    await condition.waitForDeployment();
  });

  it("deploys with owner set", async function () {
    expect(await condition.owner()).to.equal(owner.address);
  });

  it("checkWriteCondition passes for correct owner", async function () {
    const data = ethers.AbiCoder.defaultAbiCoder().encode(["address"], [owner.address]);
    await expect(condition.checkWriteCondition(owner.address, data)).to.not.be.reverted;
  });

  it("checkWriteCondition reverts for wrong address", async function () {
    const data = ethers.AbiCoder.defaultAbiCoder().encode(["address"], [owner.address]);
    await expect(condition.checkWriteCondition(caller.address, data))
      .to.be.revertedWith("TimedAccessCondition: not vault owner");
  });

  it("checkReadCondition reverts when expired", async function () {
    const pastExpiry = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago
    const condData   = ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "address", "uint256"], [LIC, IP_ID, pastExpiry]
    );
    const auxData = ethers.AbiCoder.defaultAbiCoder().encode(["uint256[]"], [[1n]]);
    await expect(condition.checkReadCondition(caller.address, condData, auxData))
      .to.be.revertedWith("TimedAccessCondition: access window has expired");
  });

  it("checkReadCondition reverts with no tokens when not expired", async function () {
    const futureExpiry = Math.floor(Date.now() / 1000) + 86400;
    const condData = ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "address", "uint256"], [LIC, IP_ID, futureExpiry]
    );
    const auxData = ethers.AbiCoder.defaultAbiCoder().encode(["uint256[]"], [[]]);
    await expect(condition.checkReadCondition(caller.address, condData, auxData))
      .to.be.revertedWith("TimedAccessCondition: no license tokens provided");
  });

  it("registerVault records expiry", async function () {
    const expiry = Math.floor(Date.now() / 1000) + 86400;
    await condition.registerVault(42n, expiry);
    expect(await condition.vaultExpiry(42n)).to.equal(BigInt(expiry));
    expect(await condition.vaultOwner(42n)).to.equal(owner.address);
  });

  it("isAccessible returns true before expiry", async function () {
    const expiry = Math.floor(Date.now() / 1000) + 86400;
    await condition.registerVault(1n, expiry);
    expect(await condition.isAccessible(1n)).to.be.true;
  });

  it("isAccessible returns true for unregistered vault", async function () {
    expect(await condition.isAccessible(999n)).to.be.true;
  });

  it("timeRemaining returns positive value before expiry", async function () {
    const expiry = Math.floor(Date.now() / 1000) + 86400;
    await condition.registerVault(2n, expiry);
    const remaining = await condition.timeRemaining(2n);
    expect(remaining).to.be.gt(0n);
    expect(remaining).to.be.lte(86400n);
  });

  it("timeRemaining returns 0 for unregistered vault", async function () {
    expect(await condition.timeRemaining(999n)).to.equal(0n);
  });

  it("extendExpiry increases expiry", async function () {
    const expiry1 = Math.floor(Date.now() / 1000) + 86400;
    const expiry2 = expiry1 + 86400;
    await condition.registerVault(3n, expiry1);
    await condition.extendExpiry(3n, expiry2);
    expect(await condition.vaultExpiry(3n)).to.equal(BigInt(expiry2));
  });

  it("extendExpiry reverts if reducing expiry", async function () {
    const expiry1 = Math.floor(Date.now() / 1000) + 86400;
    await condition.registerVault(4n, expiry1);
    await expect(condition.extendExpiry(4n, expiry1 - 3600))
      .to.be.revertedWith("TimedAccessCondition: can only extend, not reduce expiry");
  });

  it("extendExpiry reverts for non-owner", async function () {
    const expiry = Math.floor(Date.now() / 1000) + 86400;
    await condition.registerVault(5n, expiry);
    await expect(condition.connect(other).extendExpiry(5n, expiry + 86400))
      .to.be.revertedWith("TimedAccessCondition: not vault owner");
  });

  it("encodeReadConditionData encodes correctly", async function () {
    const expiry  = Math.floor(Date.now() / 1000) + 86400;
    const encoded = await condition.encodeReadConditionData(LIC, IP_ID, expiry);
    const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
      ["address", "address", "uint256"], encoded
    );
    expect(decoded[0]).to.equal(LIC);
    expect(decoded[1].toLowerCase()).to.equal(IP_ID.toLowerCase());
    expect(decoded[2]).to.equal(BigInt(expiry));
  });
});
