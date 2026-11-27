import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

export default defineConfig({
  ...ultracite,
  ignorePatterns: [
    ...ultracite.ignorePatterns,
    "tools/oxlint/anti-slop/**",
    ".agents/**",
    // Stored-contract fixtures are the exact bytes Directorate writes; reformatting them would break the round-trip test.
    "packages/opencode-directorate/test/stored/**",
  ],
});
