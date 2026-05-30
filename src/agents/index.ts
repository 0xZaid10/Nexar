// src/agents/index.ts
// Layer 5: Agent Coordination — full entry point.

export { BaseAgent }    from "./BaseAgent.js";
export { ProviderAgent } from "./ProviderAgent.js";
export { ConsumerAgent } from "./ConsumerAgent.js";
export { Discovery, ATCPIP } from "./negotiation/index.js";
export type { AgentConfig } from "./BaseAgent.js";
export type { DiscoveredAsset, DiscoveryFilters } from "./negotiation/Discovery.js";
