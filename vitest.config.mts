import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@shared": path.resolve(directory, "src/shared"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reportsDirectory: "coverage",
      reporter: ["text", "html", "lcov", "json-summary"],
      include: ["src/main/**/*.ts", "src/renderer/**/*.{ts,tsx}", "src/shared/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/main/index.ts",
        "src/renderer/global.d.ts",
        "src/renderer/main.tsx",
        "src/shared/types.ts",
      ],
      thresholds: {
        statements: 52,
        branches: 43,
        functions: 52,
        lines: 54,
        "src/main/**/*.ts": {
          statements: 75,
          branches: 65,
          functions: 75,
          lines: 76,
        },
        "src/shared/**/*.ts": {
          statements: 95,
          branches: 90,
          functions: 95,
          lines: 95,
        },
      },
    },
  },
});
