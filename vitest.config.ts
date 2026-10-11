import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    testTimeout: 15000,
    // bench/ holds other projects vendored into this folder (OpenViking), and
    // downloads/ holds whatever was pulled down. Both have their own suites that
    // fail here for their own reasons — 152 collect errors of signal-free noise
    // on top of this repo's 21 test files.
    exclude: ["**/node_modules/**", "**/dist/**", "bench/**", "downloads/**", "ui/dist/**"]
  }
});
