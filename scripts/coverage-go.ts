#!/usr/bin/env node
// Coverage ratchet for packages/sync, like coverage.thresholds in vitest.config.ts: red below the
// recorded number, and the number goes up when coverage grows (commit it). See docs/TESTING.md.
//
//   node scripts/coverage-go.ts            raises the threshold when coverage grew
//   node scripts/coverage-go.ts --check    only compares (CI)
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const THRESHOLD = "packages/sync/coverage-threshold.txt";
const check = process.argv.includes("--check");

const dir = mkdtempSync(join(tmpdir(), "ttm-cover-"));
const profile = join(dir, "cover.out");
try {
    execFileSync("go", ["-C", "packages/sync", "test", `-coverprofile=${profile}`, "./internal/..."], { stdio: "inherit" });
    const report = execFileSync("go", ["-C", "packages/sync", "tool", "cover", `-func=${profile}`], { encoding: "utf8" });
    const total = /^total:.*?([\d.]+)%$/m.exec(report);
    if (!total) throw new Error("no total in the coverage report");
    const coverage = Number(total[1]);
    const threshold = Number(readFileSync(THRESHOLD, "utf8"));
    console.log(`Go coverage ${coverage}%, threshold ${threshold}%`);
    if (coverage < threshold) process.exitCode = 1;
    else if (coverage > threshold && !check) writeFileSync(THRESHOLD, `${coverage}\n`);
} finally {
    rmSync(dir, { recursive: true, force: true });
}
