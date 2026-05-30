// src/licensing/index.ts
// Layer 3: Programmable Licensing Engine — full entry point.

export { PILBuilder, pctToStoryUnits, storyUnitsToPct } from "./PILBuilder.js";
export { HookManager }                                   from "./HookManager.js";
export { LicensingEngine }                               from "./LicensingEngine.js";
export { DerivativeEngine }                              from "./DerivativeEngine.js";
export type { LicenseTerms, LicensingConfig }            from "./PILBuilder.js";
