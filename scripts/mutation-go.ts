#!/usr/bin/env node
// Runs go-mutesting over packages/sync. Run directly it covers the whole module and acts as the
// gate (test:mutation:full); scripts/mutation-diff.ts calls runGoMutation with the scope of a diff.
import { execFile, execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { acceptGo, addWholeFiles, formatGate, fromGoReport, gatePassed, judge, type GoReport, type MutationReport, type Scope } from "./mutation-scope.ts";

const MODULE = "packages/sync";
const TOOLS = resolve("tools/mutation");
/** Seconds per mutant; a hang fails go test, which counts as killed. */
const TIMEOUT = 90;
const THRESHOLD = 100;

/** One file in its own copy of the module: the working tree stays clean and files can run in parallel. */
async function mutateFile(tool: string, file: string, ranges: string): Promise<MutationReport> {
    const root = mkdtempSync(join(tmpdir(), "ttm-mutation-"));
    try {
        cpSync(MODULE, join(root, MODULE), { recursive: true });
        // The merge corpus shared with the server.
        cpSync("packages/git/test", join(root, "packages/git/test"), { recursive: true });
        const cwd = join(root, MODULE);
        await promisify(execFile)(
            tool,
            [`--config=${join(TOOLS, "config.yml")}`, `--exec=${join(TOOLS, "exec.sh")}`, `--exec-timeout=${TIMEOUT}`, `./${relative(MODULE, file)}`],
            { cwd, env: { ...process.env, TTM_MUTATION_RANGES: ranges }, maxBuffer: 1024 * 1024 * 1024 },
        );
        return fromGoReport(JSON.parse(readFileSync(join(cwd, "report.json"), "utf8")) as GoReport, file);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

export async function runGoMutation(scope: Scope): Promise<MutationReport> {
    // A red baseline would make every mutant look killed.
    execFileSync("go", ["-C", MODULE, "test", "./internal/..."], { stdio: "inherit" });
    const scratch = mkdtempSync(join(tmpdir(), "ttm-mutation-tool-"));
    try {
        const tool = join(scratch, "go-mutesting");
        execFileSync("go", ["-C", TOOLS, "build", "-o", tool, "github.com/avito-tech/go-mutesting/cmd/go-mutesting"], { stdio: "inherit" });
        const queue = [...scope];
        const report: MutationReport = { files: {} };
        const worker = async () => {
            for (let next = queue.shift(); next; next = queue.shift()) {
                const [file, entry] = next;
                console.error(`mutation: ${file}`);
                const ranges = entry.whole ? "" : entry.ranges.map(([start, end]) => `${start}-${end}`).join(" ");
                Object.assign(report.files, (await mutateFile(tool, file, ranges)).files);
            }
        };
        await Promise.all(Array.from({ length: Math.max(1, availableParallelism() >> 1) }, worker));
        return report;
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
}

function allFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true, recursive: true })
        .filter(entry => entry.isFile())
        .map(entry => join(entry.parentPath, entry.name))
        .filter(acceptGo);
}

if (import.meta.main) {
    const only = process.argv.slice(2);
    const scope: Scope = new Map();
    addWholeFiles(scope, only.length > 0 ? only : allFiles(join(MODULE, "internal")));
    const result = judge(await runGoMutation(scope), scope);
    const summary = formatGate(result, THRESHOLD);
    mkdirSync(dirname("reports/mutation/gate-go.md"), { recursive: true });
    writeFileSync("reports/mutation/gate-go.md", summary);
    console.log(summary);
    process.exit(gatePassed(result, THRESHOLD) ? 0 : 1);
}
