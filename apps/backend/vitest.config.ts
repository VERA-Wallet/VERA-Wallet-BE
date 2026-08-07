import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import swc from "unplugin-swc";

export default defineConfig({
  plugins: [swc.vite({
    module: { type: "es6" },
    jsc: { parser: { syntax: "typescript", decorators: true }, transform: { legacyDecorator: true, decoratorMetadata: true } },
  })],
  resolve: {
    alias: {
      "@vera/interfaces": fileURLToPath(new URL("../../packages/interfaces/src/index.ts", import.meta.url)),
      "@vera/tax-engine": fileURLToPath(new URL("../../packages/tax-engine/src/index.ts", import.meta.url)),
    },
  },
  test: { environment: "node", globals: true, hookTimeout: 20_000, testTimeout: 20_000 },
});
