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
  // 테스트는 mock 여정을 전제한다. 개발자의 로컬 .env(MOCK_MODE=false 등)에 흔들리지 않게 고정한다.
  test: { environment: "node", globals: true, hookTimeout: 20_000, testTimeout: 20_000, env: { MOCK_MODE: "true" } },
});
