import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitRaw } from "./git.ts";

/** Files above this size are not merged line by line: the newer side wins. */
export const TEXT_MERGE_LIMIT = 1024 * 1024;

/** Above this many LCS cells the in-process diff is too slow; git's diff takes over. */
const MAX_DIFF_CELLS = 4_000_000;

export function isBinary(content: Buffer): boolean {
    return content.subarray(0, 8000).includes(0);
}

export function isMergeableText(...contents: Buffer[]): boolean {
    return contents.every(c => c.length <= TEXT_MERGE_LIMIT && !isBinary(c));
}

/** A change to base lines [start, end), replaced by `lines`. start === end is a pure insertion. */
interface Hunk {
    start: number;
    end: number;
    lines: string[];
}

function splitLines(text: string): string[] {
    if (text === "") return [];
    const lines = text.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    return lines;
}

/** Hunks turning `base` into `side`, from a longest common subsequence of lines. */
function diff(base: string[], side: string[]): Hunk[] | undefined {
    let prefix = 0;
    while (prefix < base.length && prefix < side.length && base[prefix] === side[prefix]) prefix++;
    let suffix = 0;
    while (
        suffix < base.length - prefix &&
        suffix < side.length - prefix &&
        base[base.length - 1 - suffix] === side[side.length - 1 - suffix]
    ) suffix++;
    const a = base.slice(prefix, base.length - suffix);
    const b = side.slice(prefix, side.length - suffix);
    if ((a.length + 1) * (b.length + 1) > MAX_DIFF_CELLS) return undefined;

    // lcs[i][j]: LCS length of a[i..] and b[j..].
    const width = b.length + 1;
    const lcs = new Uint32Array((a.length + 1) * width);
    for (let i = a.length - 1; i >= 0; i--) {
        for (let j = b.length - 1; j >= 0; j--) {
            lcs[i * width + j] = a[i] === b[j]
                ? lcs[(i + 1) * width + j + 1]! + 1
                : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!);
        }
    }
    const hunks: Hunk[] = [];
    let current: Hunk | undefined;
    let i = 0;
    let j = 0;
    const flush = () => {
        if (current) hunks.push(current);
        current = undefined;
    };
    while (i < a.length || j < b.length) {
        if (i < a.length && j < b.length && a[i] === b[j]) {
            flush();
            i++;
            j++;
        } else if (j < b.length && (i === a.length || lcs[i * width + j + 1]! >= lcs[(i + 1) * width + j]!)) {
            current ??= { start: prefix + i, end: prefix + i, lines: [] };
            current.lines.push(b[j++]!);
        } else {
            current ??= { start: prefix + i, end: prefix + i, lines: [] };
            current.end = prefix + ++i;
        }
    }
    flush();
    return hunks;
}

function overlaps(x: Hunk, y: Hunk): boolean {
    // Two insertions at the same spot compete for the same place.
    if (x.start === x.end && y.start === y.end) return x.start === y.start;
    return x.start < y.end && y.start < x.end;
}

/** Applies hunks (sorted, non-overlapping) to base lines [from, to). */
function apply(base: string[], hunks: Hunk[], from: number, to: number): string[] {
    const out: string[] = [];
    let pos = from;
    for (const hunk of hunks) {
        out.push(...base.slice(pos, hunk.start), ...hunk.lines);
        pos = hunk.end;
    }
    out.push(...base.slice(pos, to));
    return out;
}

/**
 * diff3-style merge. Changes that don't touch the same base lines — including adjacent ones — merge
 * cleanly. Where both sides changed the same lines differently, ours comes first, followed by
 * the lines of theirs that ours doesn't already have. Lines are never lost.
 */
function mergeLines(base: string[], ours: Hunk[], theirs: Hunk[]): string[] {
    const tagged = [
        ...ours.map(hunk => ({ hunk, side: 0 as const })),
        ...theirs.map(hunk => ({ hunk, side: 1 as const })),
    ].sort((x, y) => x.hunk.start - y.hunk.start || x.hunk.end - y.hunk.end || x.side - y.side);

    const out: string[] = [];
    let pos = 0;
    let k = 0;
    while (k < tagged.length) {
        // Grow a cluster of hunks that transitively overlap each other.
        const cluster = [tagged[k++]!];
        let start = cluster[0]!.hunk.start;
        let end = cluster[0]!.hunk.end;
        while (k < tagged.length && cluster.some(c => overlaps(c.hunk, tagged[k]!.hunk))) {
            const next = tagged[k++]!;
            cluster.push(next);
            start = Math.min(start, next.hunk.start);
            end = Math.max(end, next.hunk.end);
        }
        out.push(...base.slice(pos, start));
        const oursPart = apply(base, cluster.filter(c => c.side === 0).map(c => c.hunk), start, end);
        const theirsPart = apply(base, cluster.filter(c => c.side === 1).map(c => c.hunk), start, end);
        if (!cluster.some(c => c.side === 1)) out.push(...oursPart);
        else if (!cluster.some(c => c.side === 0)) out.push(...theirsPart);
        else {
            const seen = new Set(oursPart);
            out.push(...oursPart, ...theirsPart.filter(line => !seen.has(line)));
        }
        pos = end;
    }
    out.push(...base.slice(pos));
    return out;
}

async function gitUnionMerge(base: string, ours: string, theirs: string): Promise<Buffer> {
    const dir = await mkdtemp(join(tmpdir(), "ttm-merge-"));
    try {
        const files = { ours: join(dir, "ours"), base: join(dir, "base"), theirs: join(dir, "theirs") };
        await writeFile(files.ours, ours);
        await writeFile(files.base, base);
        await writeFile(files.theirs, theirs);
        const result = await gitRaw(dir, ["merge-file", "--union", "-p", files.ours, files.base, files.theirs]);
        // merge-file exits with the number of conflicts; errors are negative, i.e. >= 128 here.
        if (result.code >= 128 || result.code < 0) throw new Error(`git merge-file failed: ${result.stderr}`);
        return result.stdout;
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

/**
 * Three-way line merge that never produces conflict markers and never loses a line.
 * A missing final newline is added so the last lines of the two sides can't glue together.
 */
export async function mergeText(base: Buffer, ours: Buffer, theirs: Buffer): Promise<Buffer> {
    if (ours.equals(theirs) || base.equals(theirs)) return ours;
    if (base.equals(ours)) return theirs;
    const [b, o, t] = [base, ours, theirs].map(c => splitLines(c.toString("utf8"))) as [string[], string[], string[]];
    const oursHunks = diff(b, o);
    const theirsHunks = diff(b, t);
    if (!oursHunks || !theirsHunks) {
        const text = (lines: string[]) => lines.map(line => `${line}\n`).join("");
        return gitUnionMerge(text(b), text(o), text(t));
    }
    return Buffer.from(mergeLines(b, oursHunks, theirsHunks).map(line => `${line}\n`).join(""));
}
