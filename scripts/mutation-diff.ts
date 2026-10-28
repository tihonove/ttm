#!/usr/bin/env node
// Mutation gate on a diff: mutates only the lines changed against a base, then judges the
// mutants of that scope itself. See docs/TESTING.md.
//
//   npm run test:mutation                    diff against the merge-base with origin/main
//   npm run test:mutation -- --base <ref>    another base
//   npm run test:mutation -- --scope-only    only print what would be mutated
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { addWholeFiles, formatGate, gatePassed, judge, mutateArgs, mutateFilter, scopeFromDiff, type MutationReport } from "./mutation-scope.ts";

const REPORT = "reports/mutation/mutation.json";
const GATE = "reports/mutation/gate.md";

const { values } = parseArgs({
    options: { base: { type: "string" }, "scope-only": { type: "boolean", default: false } },
});

function git(args: string[]): { ok: boolean; out: string } {
    const result = spawnSync("git", args, { encoding: "utf8" });
    return { ok: result.status === 0, out: result.stdout.trim() };
}

function resolveBase(): string {
    if (values.base) return values.base;
    git(["fetch", "-q", "origin", "main"]);
    for (const ref of ["origin/main", "main"]) {
        const base = git(["merge-base", "HEAD", ref]);
        if (base.ok) {
            console.error(`mutation: base ${ref} @ ${base.out.slice(0, 10)}`);
            return base.out;
        }
    }
    throw new Error("no base: pass --base <ref>");
}

const config = JSON.parse(readFileSync("stryker.config.json", "utf8")) as { mutate: string[]; thresholds: { break: number } };
const accept = mutateFilter(config.mutate);
const base = resolveBase();
// Working tree against the base, so uncommitted edits count too; untracked files are new files.
const scope = scopeFromDiff(git(["diff", "-U0", "--no-color", "--no-ext-diff", base]).out, accept);
addWholeFiles(scope, git(["ls-files", "--others", "--exclude-standard"]).out.split("\n").filter(p => p && accept(p)));

const mutate = mutateArgs(scope);
mkdirSync("reports/mutation", { recursive: true });
if (mutate.length === 0) {
    console.log("mutation: empty scope, nothing to mutate");
    writeFileSync(GATE, "### Mutation gate: empty scope\n");
    process.exit(0);
}
console.error(`mutation: scope\n  ${mutate.join("\n  ")}`);
if (values["scope-only"]) process.exit(0);

const started = Date.now();
// Stryker's own exit code also reflects stale incremental results outside the scope: ignored.
spawnSync("npx", ["stryker", "run", "--incremental", "--mutate", mutate.join(",")], { stdio: "inherit" });
if ((statSync(REPORT, { throwIfNoEntry: false })?.mtimeMs ?? 0) < started) {
    console.error(`mutation: Stryker did not write a fresh ${REPORT}`);
    writeFileSync(GATE, "### Mutation gate: error\n\nStryker did not produce a report.\n");
    process.exit(1);
}
const result = judge(JSON.parse(readFileSync(REPORT, "utf8")) as MutationReport, scope);
const summary = formatGate(result, config.thresholds.break);
writeFileSync(GATE, summary);
console.log(summary);
process.exit(gatePassed(result, config.thresholds.break) ? 0 : 1);
