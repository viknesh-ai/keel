import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.NORTHWIND_WEB_PORT ?? 4001),
    // The UI talks to the API on its own origin in production; in dev the proxy
    // keeps the session cookie first-party, which SameSite=lax requires.
    proxy: {
      "/api": { target: "http://localhost:4000", changeOrigin: false },
      "/openapi.yaml": { target: "http://localhost:4000" },
    },
  },
});
