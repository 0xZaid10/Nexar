// src/core/userClients.ts
// Creates Story Protocol + viem clients signed by a specific user's Privy wallet.
// Used for user-owned transactions: IP registration, license purchase.
// Operator client is only used for platform-level operations.

import { createPublicClient, createWalletClient, http } from "viem";
import { StoryClient }    from "@story-protocol/core-sdk";
import { CDRClient }      from "@piplabs/cdr-sdk";
import { WalletManager }  from "../auth/WalletManager.js";
import { NETWORK, CDR_API_URL } from "./config.js";
import { createLogger }   from "./logger.js";
import type { Account }   from "viem";

const log        = createLogger("UserClients");
const walletMgr  = new WalletManager();

export interface UserClientBundle {
  account:       Account;
  publicClient:  ReturnType<typeof createPublicClient>;
  walletClient:  ReturnType<typeof createWalletClient>;
  storyClient:   ReturnType<typeof StoryClient.newClient>;
  cdrClient:     CDRClient;
}

/**
 * Get fully wired clients for a specific user.
 * All transactions signed by the user's Privy MPC wallet.
 * No operator key involved.
 */
export async function getUserClients(label: string): Promise<UserClientBundle> {
  // Ensure wallet exists
  if (!walletMgr.hasWallet(label)) {
    await walletMgr.createWallet(label);
  }

  const account      = await walletMgr.getAccount(label);
  const publicClient = createPublicClient({ transport: http(NETWORK.rpc) });
  const walletClient = createWalletClient({ account, transport: http(NETWORK.rpc) });

  const storyClient = StoryClient.newClient({
    account,
    transport: http(NETWORK.rpc),
    chainId:   "aeneid",
  });

  const cdrClient = new CDRClient({
    network:      "testnet",
    publicClient,
    walletClient,
    apiUrl:       CDR_API_URL,
  });

  log.debug("User clients ready", { label, address: account.address });

  return { account, publicClient, walletClient, storyClient, cdrClient };
}
