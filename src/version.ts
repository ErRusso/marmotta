// Single source of truth for the version reported by the CLI. A standalone executable cannot read
// package.json at runtime, so the version is a constant in the source; scripts/check-version.mjs
// fails the test run when it drifts from package.json.
export const MARMOTTA_VERSION = '0.6.0';
