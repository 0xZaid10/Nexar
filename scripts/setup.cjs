// scripts/setup.cjs
// Create SPG NFT collection and verify connectivity.
// Run AFTER deploy.cjs and updating .env with contract addresses.
// Run: node scripts/setup.cjs

require("dotenv").config();
const { StoryClient } = require("@story-protocol/core-sdk");
const { http }         = require("viem");
const { privateKeyToAccount } = require("viem/accounts");
const fs = require("fs");

const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) { console.error("PRIVATE_KEY not set"); process.exit(1); }

async function main() {
  console.log("══════════════════════════════════════════");
  console.log("  NEXAR Setup — Aeneid");
  console.log("══════════════════════════════════════════");

  const account = privateKeyToAccount(`0x${PRIVATE_KEY.replace(/^0x/, "")}`);
  console.log(`Account: ${account.address}`);

  const client = StoryClient.newClient({
    account,
    transport: http(process.env.RPC_URL || "https://aeneid.storyrpc.io"),
    chainId: "aeneid",
  });

  // Check if already set
  const existing = process.env.NEXAR_SPG_NFT_ADDR;
  if (existing && existing !== "0x0000000000000000000000000000000000000000") {
    console.log(`SPG NFT collection already set: ${existing}`);
  } else {
    console.log("\nCreating CIPHER SPG NFT collection...");
    const result = await client.nftClient.createNFTCollection({
      name:             "NEXAR Intelligence Assets",
      symbol:           "NEXAR",
      isPublicMinting:  false,
      mintOpen:         true,
      mintFeeRecipient: account.address,
      contractURI:      "",
    });

    const addr = result.spgNftContract;
    console.log(`✔  SPG NFT Collection: ${addr}`);
    console.log(`   tx: ${result.txHash}`);
    console.log(`\nAdd to .env:\nNEXAR_SPG_NFT_ADDR=${addr}`);

    fs.appendFileSync(".env.deployed", `\nNEXAR_SPG_NFT_ADDR=${addr}\n`);
    console.log("✔  Address appended to .env.deployed");
  }

  console.log("\n══════════════════════════════════════════");
  console.log("  Setup complete.");
  console.log("  Next: update .env then run: node scripts/verify.cjs");
  console.log("══════════════════════════════════════════");
}

main().catch((err) => {
  console.error("Setup failed:", err.message || err);
  process.exit(1);
});
