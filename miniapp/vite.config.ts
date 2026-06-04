import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base:    "/app/",                        // ← fixes asset paths
  build:   { outDir: "../public/app" },
  server:  { proxy: { "/api": "http://localhost:3001" } },
});
