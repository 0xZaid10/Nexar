// src/core/clients.ts
// Factory functions for StoryClient and CDRClient.
// Every NEXAR module calls these — never instantiate clients directly.
// Confirmed against: developers/typescript-sdk/setup.md
//                    developers/cdr-sdk/setup.md

import { StoryClient, type StoryConfig } from "@story-protocol/core-sdk";
import { CDRClient, initWasm } from "@piplabs/cdr-sdk";
import {
  createPublicClient,
  createWalletClient,
  http,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount, type Account } from "viem/accounts";
import { NETWORK } from "./config.js";
import { createLogger } from "./logger.js";
import { NexarError } from "./errors.js";

const log = createLogger("clients");

// ─── Wasm init (must be called once before any CDR crypto op) ─────────────────

let wasmInitialized = false;

export async function ensureWasmInit(): Promise<void> {
  if (wasmInitialized) return;
  await initWasm();
  wasmInitialized = true;
  log.debug("CDR WASM initialized");
}

// ─── Account factory ──────────────────────────────────────────────────────────

export function accountFromPrivateKey(privateKey: string): Account {
  const key = privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
  return privateKeyToAccount(key as `0x${string}`);
}

// ─── Viem clients ─────────────────────────────────────────────────────────────

export function createViemPublicClient(rpcUrl?: string): PublicClient {
  return createPublicClient({
    transport: http(rpcUrl ?? NETWORK.rpc),
  });
}

export function createViemWalletClient(
  account: Account,
  rpcUrl?: string
): WalletClient {
  return createWalletClient({
    account,
    transport: http(rpcUrl ?? NETWORK.rpc),
  });
}

// ─── Story SDK client ─────────────────────────────────────────────────────────

/**
 * Create a fully configured StoryClient for the Aeneid testnet.
 * Confirmed signature from developers/typescript-sdk/setup.md:
 *   StoryClient.newClient({ account, transport, chainId })
 */
export function createStoryClient(account: Account): ReturnType<typeof StoryClient.newClient> {
  const config: StoryConfig = {
    account,
    transport: http(NETWORK.rpc),
    chainId:   "aeneid",
  };

  try {
    const client = StoryClient.newClient(config);
    log.debug("StoryClient initialized", { account: account.address });
    return client;
  } catch (err) {
    throw new NexarError(
      "CLIENT_INIT_FAILED",
      "Failed to initialize StoryClient",
      { cause: err }
    );
  }
}

// ─── CDR client ───────────────────────────────────────────────────────────────

/**
 * Create a CDRClient with full read + write capability.
 * Confirmed signature from developers/cdr-sdk/setup.md:
 *   new CDRClient({ network, publicClient, walletClient, apiUrl })
 */
export function createCDRClient(
  publicClient: PublicClient,
  walletClient?: WalletClient,
  apiUrl?: string
): CDRClient {
  try {
    const client = new CDRClient({
      network:      "testnet",
      publicClient,
      walletClient,
      apiUrl:       apiUrl ?? NETWORK.cdrApiUrl,
    });
    log.debug("CDRClient initialized", {
      mode:   walletClient ? "read+write" : "read-only",
      apiUrl: apiUrl ?? NETWORK.cdrApiUrl,
    });
    return client;
  } catch (err) {
    throw new NexarError(
      "CLIENT_INIT_FAILED",
      "Failed to initialize CDRClient",
      { cause: err }
    );
  }
}


// ─── Full client bundle ───────────────────────────────────────────────────────

export interface ClientBundle {
  account:       Account;
  publicClient:  PublicClient;
  walletClient:  WalletClient;
  storyClient:   ReturnType<typeof StoryClient.newClient>;
  cdrClient:     CDRClient;
}

/**
 * Initialize all clients in one call.
 * Called by every agent and by the demo runner.
 *
 * @param privateKey - Raw private key string (with or without 0x prefix)
 * @param rpcUrl     - Optional RPC override
 * @param apiUrl     - Optional CDR API URL override
 */
export async function initClients(
  privateKey: string,
  rpcUrl?:    string,
  apiUrl?:    string
): Promise<ClientBundle> {
  log.info("Initializing NEXAR clients...");

  await ensureWasmInit();

  const account       = accountFromPrivateKey(privateKey);
  const publicClient  = createViemPublicClient(rpcUrl);
  const walletClient  = createViemWalletClient(account, rpcUrl);
  const storyClient   = createStoryClient(account);
  const cdrClient     = createCDRClient(publicClient, walletClient, apiUrl);

  log.success("All clients initialized", { address: account.address });

  return {
    account,
    publicClient,
    walletClient,
    storyClient,
    cdrClient,
  };
}
