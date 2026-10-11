const { spawnSync } = require("node:child_process");

const result = spawnSync(
  process.execPath,
  [
    "--experimental-strip-types",
    "--loader",
    "./scripts/tests/typescript-loader.mjs",
    "scripts/tests/data-loss-integration.mjs",
  ],
  { stdio: "inherit" },
);

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
