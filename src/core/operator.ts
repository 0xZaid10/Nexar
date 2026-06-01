// src/core/operator.ts
// Singleton operator client — initialized once on server start.
// Routes import this instead of calling initClients(PRIVATE_KEY) on every request.
// The operator wallet signs on-chain transactions (IP registration, license minting)
// on behalf of the NEXAR platform. User-specific actions use their Privy wallets.

import { initClients }    from "./clients.js";
import { createLogger }   from "./logger.js";
import type { ClientBundle } from "./clients.js";

const log = createLogger("Operator");

let _clients: ClientBundle | null = null;
let _initPromise: Promise<ClientBundle> | null = null;

export async function getOperator(): Promise<ClientBundle> {
  if (_clients) return _clients;
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    const pk = process.env.PRIVATE_KEY;
    if (!pk) throw new Error("PRIVATE_KEY not set — cannot initialize operator");

    log.info("Initializing operator client...");
    _clients = await initClients(pk);
    log.success("Operator ready", { address: _clients.account.address });
    return _clients;
  })();

  return _initPromise;
}

// Reset — useful for testing
export function resetOperator(): void {
  _clients     = null;
  _initPromise = null;
}
