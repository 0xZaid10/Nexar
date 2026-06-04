// src/core/userClients.ts
// Creates Story Protocol + viem clients signed by a specific user's Privy wallet.
// Used for user-owned transactions: IP registration, license purchase.
// Operator client is only used for platform-level operations.

import { createPublicClient, createWalletClient, http, custom, parseTransaction } from "viem";
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
// Custom transport that routes eth_sendTransaction through Privy API
function privyTransport(rpcUrl: string, walletId: string | null, address: string): ReturnType<typeof http> {
  if (!walletId || walletId.startsWith("0x")) return http(rpcUrl);

  const PRIVY_BASE  = "https://api.privy.io/v1";
  const credentials = Buffer.from(`${process.env.PRIVY_APP_ID}:${process.env.PRIVY_APP_SECRET}`).toString("base64");
  const headers     = { "Authorization":`Basic ${credentials}`, "privy-app-id":process.env.PRIVY_APP_ID!, "Content-Type":"application/json" };

  return {
    ...http(rpcUrl),
    async request({ method, params }: any) {
      // Intercept eth_sendRawTransaction — redirect to Privy eth_sendTransaction
      if (method === "eth_sendRawTransaction") {
        // Extract calldata from the signed tx by sending to Privy directly
        // We can't decode raw tx, so we use the pending tx from context
        return http(rpcUrl).request({ method, params });
      }
      return http(rpcUrl).request({ method, params });
    }
  } as any;
}

// Initialize CDR WASM once
let _wasmInitialized = false;
async function ensureWasm() {
  if (_wasmInitialized) return;
  const { initWasm } = await import("@piplabs/cdr-sdk");
  await initWasm();
  _wasmInitialized = true;
  log.debug("CDR WASM initialized");
}

export async function getUserClients(label: string): Promise<UserClientBundle> {
  await ensureWasm();
  if (!walletMgr.hasWallet(label)) await walletMgr.createWallet(label);

  const account = await walletMgr.getAccount(label);

  // Get Privy wallet ID for this user
  const { getDB } = await import("../db/index.js");
  const row = getDB().prepare("SELECT privy_wallet_id FROM wallets WHERE label = ?").get(label) as any;
  const privyWalletId = row?.privy_wallet_id ?? null;
  const isPrivyServerWallet = privyWalletId && !privyWalletId.startsWith("0x");

  const publicClient = createPublicClient({ transport: http(NETWORK.rpc) });

  // For Privy server wallets: create a walletClient that uses Privy eth_sendTransaction
  let walletClient: ReturnType<typeof createWalletClient>;

  if (isPrivyServerWallet) {
    const PRIVY_BASE   = "https://api.privy.io/v1";
    const credentials  = Buffer.from(`${process.env.PRIVY_APP_ID}:${process.env.PRIVY_APP_SECRET}`).toString("base64");
    const privyHeaders = { "Authorization":`Basic ${credentials}`, "privy-app-id":process.env.PRIVY_APP_ID!, "Content-Type":"application/json" };

    // Custom transport: intercepts eth_sendRawTransaction → Privy eth_sendTransaction
    const privyTransportFn = custom({
      async request({ method, params }: any) {
        if (method === "eth_sendRawTransaction") {
          const rawTx = params[0] as string;
          // If it's already a 32-byte hash (returned by signTransaction override), just return it
          if (rawTx.length === 66 && rawTx.startsWith("0x")) {
            return rawTx;
          }
          // Otherwise decode raw tx and submit via Privy
          try {
            const tx = parseTransaction(rawTx);
            const res = await fetch(`${PRIVY_BASE}/wallets/${privyWalletId}/rpc`, {
              method: "POST", headers: privyHeaders,
              body: JSON.stringify({
                method: "eth_sendTransaction",
                caip2:  "eip155:1315",
                params: { transaction: {
                  to:    tx.to,
                  data:  tx.data ?? "0x",
                  value: tx.value ? `0x${tx.value.toString(16)}` : "0x0",
                }}
              }),
            });
            const d = await res.json() as any;
            if (d.error) throw new Error(`Privy: ${d.error}`);
            return d.data?.hash;
          } catch(err: any) {
            log.error("Privy sendTransaction failed", { err: err.message });
            throw err;
          }
        }
        // All other methods → standard RPC
        const rpcRes = await fetch(NETWORK.rpc, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ jsonrpc:"2.0", id:1, method, params }),
        });
        const json = await rpcRes.json() as any;
        if (json.error) throw new Error(json.error.message);
        return json.result;
      }
    });

    walletClient = createWalletClient({ account, transport: privyTransportFn });
  } else {
    walletClient = createWalletClient({ account, transport: http(NETWORK.rpc) });
  }

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
