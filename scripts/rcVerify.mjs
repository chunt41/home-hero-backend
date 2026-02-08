import { spawn } from "node:child_process";

function npmCliJs() {
  const p = String(process.env.npm_execpath || "").trim();
  // When running under `npm run ...`, npm_execpath usually points to npm-cli.js.
  return p && p.endsWith(".js") ? p : null;
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, {
      stdio: "inherit",
      shell: false,
      ...opts,
    });
    p.on("error", reject);
    p.on("exit", (code) => {
      if (code === 0) return resolve();
      reject(new Error(`${cmd} ${args.join(" ")} exited with code ${code}`));
    });
  });
}

function runNpm(args, opts = {}) {
  const cli = npmCliJs();
  if (cli) return run(process.execPath, [cli, ...args], opts);

  // Fallback for non-npm invocations (best-effort).
  const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";
  return run(npmBin, args, {
    ...opts,
    shell: process.platform === "win32",
  });
}

async function main() {
  console.log("[rc:verify] starting");

  await runNpm(["run", "lint"]);
  await runNpm(["test"]);
  await runNpm(["run", "verify:gate"]);

  const smokeEnabled = String(process.env.RC_SMOKE || "").trim() === "1" || !!process.env.RC_SMOKE_URL;
  if (smokeEnabled) {
    console.log("[rc:verify] running smoke checks (RC_SMOKE enabled)");
    await run("node", ["scripts/rcSmoke.mjs"], { env: process.env });
  } else {
    console.log("[rc:verify] smoke checks skipped (set RC_SMOKE=1 or RC_SMOKE_URL)");
  }

  console.log("[rc:verify] OK");
}

main().catch((e) => {
  console.error("[rc:verify] FAIL:", e?.message || e);
  process.exitCode = 1;
});
