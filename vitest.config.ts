import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    // One isolated memory home per test file. Without it a test's result depends on what
    // this machine's ~/.ai-memory/settings.json holds — a real jev key turned "no key"
    // assertions red and sent the extraction gate to a live model.
    setupFiles: ["./tests/setup.ts"],
    testTimeout: 15000,
    // One file at a time, measured rationale (2026-11-07): this repo is tested on
    // machines that already run a dozen node sessions (daemons, MCP servers, other
    // agents). With ~1.04 GB of free commit (Win32_OperatingSystem.FreeVirtualMemory
    // 1,116,996 KB on 16 logical CPUs), the default 16-worker pool cannot even boot
    // its workers — fresh threads died at ~20 MB heap with "VirtualAlloc failed" /
    // "young object promotion failed" and vitest surfaced `Error: Worker exited
    // unexpectedly`. Not a test being heavy; the pool outbidding the machine.
    // Sequential: all 57 files green in 29.18 s on that same machine. A parallel
    // run is only safe when nobody else is home, which is not a thing the suite
    // can assume.
    fileParallelism: false,
    // bench/ holds other projects vendored into this folder (OpenViking), and
    // downloads/ holds whatever was pulled down. Both have their own suites that
    // fail here for their own reasons — 152 collect errors of signal-free noise
    // on top of this repo's 21 test files.
    exclude: ["**/node_modules/**", "**/dist/**", "bench/**", "downloads/**", "ui/dist/**"]
  }
});
