import { defineConfig } from "vitest/config";
import { resolve }      from "node:path";

export default defineConfig({
  test: {
    include:     ["test/**/*.test.ts"],
    exclude:     ["test/contracts/**"],
    environment: "node",
    globals:     true,
    testTimeout: 10_000,
    hookTimeout: 10_000,
    sequence:    { concurrent: false },

    env: {
      DB_PATH:    "./nexar-test.db",
      IPFS_PATH:  "./.nexar-ipfs-test",
      JWT_SECRET: "cipher-test-secret-64-chars-minimum-padding-here-1234567890",
    },

    // Exclude CDR SDK and noble from Vitest's ESM transform
    // These are native ESM packages that must be imported as-is
    server: {
      deps: {
        external: [
          "@piplabs/cdr-sdk",
          "@piplabs/cdr-crypto",
          "@noble/ciphers",
          "@noble/curves",
          "@noble/hashes",
          "helia",
          "@helia/unixfs",
          "blockstore-fs",
          "datastore-fs",
          "multiformats",
        ],
      },
    },

    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include:  ["src/**/*.ts"],
      exclude:  ["src/**/*.test.ts", "src/**/index.ts", "src/core/logger.ts"],
    },

    reporter: ["verbose"],
  },

  resolve: {
    alias: {
      "@cipher/core":      resolve(__dirname, "src/core/index.ts"),
      "@cipher/sdk":       resolve(__dirname, "src/sdk/index.ts"),
      "@cipher/auth":      resolve(__dirname, "src/auth/index.ts"),
      "@cipher/licensing": resolve(__dirname, "src/licensing/index.ts"),
      "@cipher/runtime":   resolve(__dirname, "src/runtime/index.ts"),
      "@cipher/agents":    resolve(__dirname, "src/agents/index.ts"),
    },
  },
});
