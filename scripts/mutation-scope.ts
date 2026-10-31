import { matchesGlob } from "node:path";

/** Lines to mutate in one file: the whole file, or inclusive [start, end] line ranges. */
export interface FileScope {
    whole: boolean;
    ranges: [number, number][];
}

export type Scope = Map<string, FileScope>;

/** Splits stryker's `mutate` list into include and exclude globs. */
export function mutateFilter(mutate: string[]): (path: string) => boolean {
    const include = mutate.filter(glob => !glob.startsWith("!"));
    const exclude = mutate.filter(glob => glob.startsWith("!")).map(glob => glob.slice(1));
    return path =>
        !path.endsWith(".d.ts") &&
        include.some(glob => matchesGlob(path, glob)) &&
        !exclude.some(glob => matchesGlob(path, glob));
}

/** Go code under mutation: as in TypeScript, everything but the process entry point. */
export function acceptGo(path: string): boolean {
    return path.startsWith("packages/sync/internal/") && path.endsWith(".go") && !path.endsWith("_test.go");
}

/** A line whose change cannot alter behaviour, so it does not pull its hunk into the scope. */
function isInert(line: string): boolean {
    const text = line.trim();
    return text === "" || text.startsWith("//") || text.startsWith("/*") || text.startsWith("*");
}

/**
 * Builds the scope from `git diff -U0` output: new files whole, changed files by the line ranges
 * their hunks add, skipping hunks that only touch comments or blank lines.
 */
export function scopeFromDiff(diff: string, accept: (path: string) => boolean): Scope {
    const scope: Scope = new Map();
    let path: string | undefined;
    let isNew = false;
    let hunk: { start: number; lines: string[] } | undefined;
    const flush = () => {
        if (!path || !hunk) return;
        const code = hunk.lines.map((line, i) => ({ line, n: hunk!.start + i })).filter(({ line }) => !isInert(line));
        if (code.length > 0) {
            const entry = scope.get(path) ?? { whole: false, ranges: [] };
            entry.ranges.push([code[0]!.n, code[code.length - 1]!.n]);
            scope.set(path, entry);
        }
        hunk = undefined;
    };
    for (const line of diff.split("\n")) {
        if (line.startsWith("diff --git ")) {
            flush();
            path = undefined;
            isNew = false;
        } else if (line.startsWith("--- ")) {
            isNew = line === "--- /dev/null";
        } else if (line.startsWith("+++ ")) {
            const target = line.slice(4);
            path = target.startsWith("b/") && accept(target.slice(2)) ? target.slice(2) : undefined;
            if (path && isNew) scope.set(path, { whole: true, ranges: [] });
        } else if (line.startsWith("@@")) {
            flush();
            const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
            if (path && match && !scope.get(path)?.whole) hunk = { start: Number(match[1]), lines: [] };
        } else if (hunk && line.startsWith("+")) {
            hunk.lines.push(line.slice(1));
        }
    }
    flush();
    return scope;
}

export function addWholeFiles(scope: Scope, paths: string[]): void {
    for (const path of paths) scope.set(path, { whole: true, ranges: [] });
}

/** Stryker `--mutate` entries: `file` or `file:start-end`. */
export function mutateArgs(scope: Scope): string[] {
    return [...scope].flatMap(([path, file]) =>
        file.whole ? [path] : file.ranges.map(([start, end]) => `${path}:${start}-${end}`),
    );
}

export interface ReportMutant {
    id: string;
    mutatorName: string;
    replacement?: string;
    status: string;
    location: { start: { line: number; column: number } };
}

export interface MutationReport {
    files: Record<string, { mutants: ReportMutant[] }>;
}

export interface ScopedMutant extends ReportMutant {
    file: string;
}

export interface GateResult {
    /** Stryker's formula: detected / (detected + undetected); errors and ignored are excluded. */
    score: number;
    counts: Record<string, number>;
    /** Mutants that make the gate red: survivors and anything left unverified. */
    blocking: ScopedMutant[];
    total: number;
}

const DETECTED = new Set(["Killed", "Timeout"]);
const UNDETECTED = new Set(["Survived", "NoCoverage"]);
/** Not a verdict: the mutant was not actually checked, so it must not pass silently. */
const UNVERIFIED = new Set(["RuntimeError", "Pending"]);

function inScope(scope: Scope, file: string, line: number): boolean {
    const entry = scope.get(file);
    if (!entry) return false;
    return entry.whole || entry.ranges.some(([start, end]) => line >= start && line <= end);
}

/**
 * Judges only mutants inside the scope: an incremental Stryker run also carries old results for
 * code outside it, which must not decide this diff.
 */
/**
 * go-mutesting's branch mutators change the body, so a mutant of an edited `if` lands on the line after
 * it, which may well be unchanged: each range takes that line in too.
 */
export function withFollowingLine(scope: Scope): Scope {
    return new Map(
        [...scope].map(([file, entry]) => [file, { ...entry, ranges: entry.ranges.map(([start, end]): [number, number] => [start, end + 1]) }]),
    );
}

export function judge(report: MutationReport, scope: Scope): GateResult {
    const counts: Record<string, number> = {};
    const blocking: ScopedMutant[] = [];
    let detected = 0;
    let undetected = 0;
    let total = 0;
    for (const [file, { mutants }] of Object.entries(report.files)) {
        for (const mutant of mutants) {
            if (!inScope(scope, file, mutant.location.start.line)) continue;
            total++;
            counts[mutant.status] = (counts[mutant.status] ?? 0) + 1;
            if (DETECTED.has(mutant.status)) detected++;
            if (UNDETECTED.has(mutant.status)) undetected++;
            if (UNDETECTED.has(mutant.status) || UNVERIFIED.has(mutant.status)) blocking.push({ ...mutant, file });
        }
    }
    const valid = detected + undetected;
    return { score: valid === 0 ? 100 : (detected / valid) * 100, counts, blocking, total };
}

export function formatGate(result: GateResult, threshold: number): string {
    const passed = gatePassed(result, threshold);
    const lines = [
        `### Mutation gate: ${passed ? "passed" : "failed"}`,
        "",
        `Score ${result.score.toFixed(2)}% (break ${threshold}%), ${result.total} mutants in the diff: ` +
            Object.entries(result.counts)
                .map(([status, n]) => `${status} ${n}`)
                .join(", "),
    ];
    if (result.blocking.length > 0) {
        lines.push("", "| Where | Mutator | Status | Replacement |", "|---|---|---|---|");
        for (const m of result.blocking) {
            const replacement = (m.replacement ?? "").replace(/\s+/g, " ").replace(/\|/g, "\\|").slice(0, 80);
            lines.push(`| \`${m.file}:${m.location.start.line}\` | ${m.mutatorName} | ${m.status} | \`${replacement}\` |`);
        }
    }
    return `${lines.join("\n")}\n`;
}

export function gatePassed(result: GateResult, threshold: number): boolean {
    return result.score >= threshold && result.blocking.length === 0;
}

export interface GoMutant {
    mutator: { mutatorName: string; originalSourceCode: string; mutatedSourceCode: string; originalFilePath: string };
}

export interface GoReport {
    killed: GoMutant[] | null;
    escaped: GoMutant[] | null;
    timeouted: GoMutant[] | null;
    errored: GoMutant[] | null;
}

/** First line where the mutant differs from the source: go-mutesting's own line can be a whole block's. */
function firstChange(original: string, mutated: string): { line: number; replacement: string } {
    const before = original.split("\n");
    const after = mutated.split("\n");
    let i = 0;
    while (i < before.length && i < after.length && before[i] === after[i]) i++;
    return { line: i + 1, replacement: (after[i] ?? "").trim() };
}

/** Puts one go-mutesting report into Stryker's shape, so one gate judges both. */
export function fromGoReport(go: GoReport, file: string): MutationReport {
    const groups: [GoMutant[] | null, string][] = [
        [go.killed, "Killed"],
        [go.timeouted, "Timeout"],
        [go.escaped, "Survived"],
        [go.errored, "RuntimeError"],
    ];
    const mutants = groups.flatMap(([group, status]) =>
        (group ?? []).map((mutant, i): ReportMutant => {
            const { line, replacement } = firstChange(mutant.mutator.originalSourceCode, mutant.mutator.mutatedSourceCode);
            return {
                id: `${status}-${i}`,
                mutatorName: mutant.mutator.mutatorName,
                replacement,
                status,
                location: { start: { line, column: 1 } },
            };
        }),
    );
    return { files: { [file]: { mutants } } };
}
