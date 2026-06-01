// scripts/setup.ts
// Post-deploy setup: create SPG NFT collection and verify all env vars are set.
// Run after: npm run deploy
// Run: npm run setup

import "dotenv/config";
import { zeroAddress }         from "viem";
import { initClients }         from "../src/core/clients.js";
import { validateEnv, validateDeployedContracts, NEXAR_SPG_NFT } from "../src/core/config.js";
import { log }                 from "../src/core/logger.js";
import { appendFileSync }      from "node:fs";

validateEnv();
validateDeployedContracts();

async function main() {
  log.deploy.separator("NEXAR Setup");

  const { storyClient, account } = await initClients(process.env.PRIVATE_KEY!);

  // ── Create SPG NFT Collection (if not already set) ───────────────────────
  if (NEXAR_SPG_NFT && NEXAR_SPG_NFT !== "0x0000000000000000000000000000000000000000") {
    log.deploy.info("SPG NFT collection already configured", { address: NEXAR_SPG_NFT });
  } else {
    log.deploy.info("Creating NEXAR SPG NFT collection...");

    // Confirmed from sdk-reference/nftclient.md createNFTCollection()
    const collection = await storyClient.nftClient.createNFTCollection({
      name:             "NEXAR Intelligence Assets",
      symbol:           "NEXAR",
      isPublicMinting:  false,       // only NEXAR backend mints
      mintFeeRecipient: zeroAddress,
      contractURI:      "",
    });

    const spgAddr = collection.spgNftContract;
    log.deploy.success("SPG NFT collection created", {
      address: spgAddr,
      txHash:  collection.txHash ?? "n/a",
    });

    // Append to .env
    appendFileSync(".env", `\nNEXAR_SPG_NFT_ADDR=${spgAddr}\n`);
    appendFileSync(".env.deployed", `\nNEXAR_SPG_NFT_ADDR=${spgAddr}\n`);
    console.log(`\nAdd to .env:\nNEXAR_SPG_NFT_ADDR=${spgAddr}\n`);
  }

  // ── Verify Story Protocol connectivity ────────────────────────────────────
  log.deploy.info("Verifying Story Protocol connectivity...");
  try {
    const terms = await storyClient.license.getLicenseTerms({ licenseTermsId: "1" });
    if (terms) {
      log.deploy.success("Story Protocol connected — licenseTermsId=1 (Non-Commercial Social Remixing) exists");
    }
  } catch (err) {
    log.deploy.warn("Could not verify licenseTermsId=1 — check RPC connectivity", { err: String(err) });
  }

  log.deploy.separator("Setup Complete");
  log.deploy.success("NEXAR is ready to use");
  console.log("\nNext steps:");
  console.log("  npm run verify    — smoke test all contracts");
  console.log("  npm run demo      — run the full end-to-end demo\n");
}

main().catch((err) => {
  log.deploy.error("Setup failed", { err: String(err) });
  process.exit(1);
});
