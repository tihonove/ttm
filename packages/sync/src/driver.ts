// Merge driver logic: writes the result into %A without conflict markers, so a sync merge never
// stops and waits for a human. The process git spawns is driver-main.ts.
import { readFile, writeFile } from "node:fs/promises";
import { gitRaw } from "@ttm/git/git";
import { isMergeableText, mergeText } from "@ttm/git/merge";

/** Env var the daemon sets to the ref being merged in, so the driver can date "their" side. */
export const THEIRS_REF_ENV = "TTM_THEIRS_REF";

export interface DriverInput {
    basePath: string;
    oursPath: string;
    theirsPath: string;
    /** Repo-relative path of the file being merged. */
    path: string;
    /** Repository the merge runs in. */
    repoDir: string;
    /** Ref of the side being merged in; without it binary files keep ours. */
    theirsRef: string | undefined;
}

async function lastChangeTime(repoDir: string, ref: string, path: string): Promise<number> {
    const result = await gitRaw(repoDir, ["log", "-1", "--format=%ct", ref, "--", path]);
    return Number(result.stdout.toString("utf8").trim()) || 0;
}

export async function runDriver(input: DriverInput): Promise<void> {
    const { basePath, oursPath, theirsPath, path, repoDir, theirsRef } = input;
    const [base, ours, theirs] = await Promise.all([readFile(basePath), readFile(oursPath), readFile(theirsPath)]);
    if (isMergeableText(base, ours, theirs)) {
        await writeFile(oursPath, await mergeText(base, ours, theirs));
        return;
    }
    // Large or binary file: last writer wins, the other version stays in history.
    if (!theirsRef) return;
    const [oursTime, theirsTime] = await Promise.all([
        lastChangeTime(repoDir, "HEAD", path),
        lastChangeTime(repoDir, theirsRef, path),
    ]);
    if (theirsTime > oursTime) await writeFile(oursPath, theirs);
}
