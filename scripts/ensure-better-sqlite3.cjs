const { spawnSync } = require("node:child_process");
const path = require("node:path");

const rootDir = path.resolve(__dirname, "..");

function hasAbiMismatch(error) {
  const message = String(error?.message || "");
  return (
    error?.code === "ERR_DLOPEN_FAILED" &&
    message.includes("NODE_MODULE_VERSION")
  );
}

function canLoadBetterSqlite3() {
  try {
    require("better-sqlite3");
    return true;
  } catch (error) {
    if (hasAbiMismatch(error)) {
      return false;
    }
    throw error;
  }
}

if (canLoadBetterSqlite3()) {
  process.exit(0);
}

console.warn(
  "[native] better-sqlite3 ABI mismatch detected. Running `npm rebuild better-sqlite3`..."
);

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const rebuild = spawnSync(npmCommand, ["rebuild", "better-sqlite3"], {
  cwd: rootDir,
  stdio: "inherit",
  env: process.env
});

if (rebuild.status !== 0) {
  process.exit(rebuild.status ?? 1);
}

if (!canLoadBetterSqlite3()) {
  console.error("[native] better-sqlite3 still failed to load after rebuild.");
  process.exit(1);
}

console.log("[native] better-sqlite3 rebuilt successfully for current Node ABI.");
