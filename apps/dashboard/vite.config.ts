import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: { port: Number(process.env.DASHBOARD_PORT ?? 3000) },
  build: {
    // Route-level code splitting is done with React.lazy in App.tsx; this keeps
    // the vendor chunk from being re-downloaded whenever app code changes.
    rollupOptions: {
      output: {
        manualChunks: {
          react: ["react", "react-dom", "react-router-dom"],
          query: ["@tanstack/react-query"],
        },
      },
    },
  },
});
