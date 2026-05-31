// src/auth/index.ts
// Layer 2: Identity + Access — full entry point.
// Multi-user: all exports are stateless per-call or per-user-scoped.

export { WalletManager }    from "./WalletManager.js";
export { SessionManager }   from "./SessionManager.js";
export { GasRelayer }       from "./GasRelayer.js";
export { AccessDelegate, Permission } from "./AccessDelegate.js";
