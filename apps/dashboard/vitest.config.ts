import { defineConfig } from "vitest/config";

// No @vitejs/plugin-react here: vitest transforms JSX with esbuild, which reads
// `jsx: react-jsx` from tsconfig. The plugin only adds Fast Refresh, which is a
// dev-server concern, and pulling it in couples this file to vite's plugin
// types across two different vite versions.
export default defineConfig({
  test: {
    include: ["test/**/*.test.tsx"],
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    css: false,
  },
});
