import { existsSync } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { basename, dirname, extname, join } from "node:path";
import { git, gitRaw, GitError, resolveRef } from "@ttm/git/git";
import { THEIRS_REF_ENV } from "./driver.ts";

export interface SyncTarget {
    /** Working tree being synced. */
    dir: string;
    /** Machine name, recorded in commit messages and conflict copies. */
    host: string;
    branch?: string;
    /** Extra env for network operations (fetch/push), e.g. an auth header. */
    networkEnv?: NodeJS.ProcessEnv;
    log?: (message: string) => void;
}

export interface SyncResult {
    committed: boolean;
    merged: boolean;
    pushed: boolean;
    conflictCopies: string[];
}

const REMOTE = "origin";
const MAX_PUSH_ATTEMPTS = 5;
const DRIVER_PATH = fileURLToPath(new URL("./driver-main.ts", import.meta.url));

// Both live in .git/info, not in the notes themselves: same effect, nothing extra in the folder.
export const ATTRIBUTES = "* merge=ttm\n";

export const EXCLUDE = [
    "# editor temp files",
    "*.swp",
    "*.swx",
    "*~",
    ".#*",
    "*.tmp",
    ".~lock.*#",
    "# sync leftovers",
    "*.orig",
    "# machine-local settings",
    ".claude/settings.local.json",
    "",
].join("\n");

/** Makes the local repo ready for syncing: merge driver, identity and default ignore files. */
export async function prepareRepo(target: SyncTarget): Promise<void> {
    const { dir } = target;
    if (!existsSync(join(dir, ".git"))) await git(dir, ["init", "-q", "-b", branchOf(target)]);
    const config: [string, string][] = [
        ["merge.ttm.name", "ttm sync merge (never conflicts)"],
        ["merge.ttm.driver", `node ${JSON.stringify(DRIVER_PATH)} %O %A %B %P`],
        ["user.name", `ttm-sync@${target.host}`],
        ["user.email", `ttm-sync@${target.host}`],
        ["core.quotePath", "false"],
        ["pull.rebase", "false"],
    ];
    for (const [key, value] of config) await git(dir, ["config", key, value]);
    const info = join(dir, ".git", "info");
    await mkdir(info, { recursive: true });
    await writeFile(join(info, "attributes"), ATTRIBUTES);
    await writeFile(join(info, "exclude"), EXCLUDE);
}

export async function setRemote(dir: string, url: string): Promise<void> {
    const current = await gitRaw(dir, ["remote", "get-url", REMOTE]);
    if (current.code !== 0) await git(dir, ["remote", "add", REMOTE, url]);
    else if (current.stdout.toString("utf8").trim() !== url) await git(dir, ["remote", "set-url", REMOTE, url]);
}

function branchOf(target: SyncTarget): string {
    return target.branch ?? "main";
}

const STALE_LOCK_MS = 60_000;

/**
 * Recovers from a sync interrupted mid-way (crash, reboot). An unfinished merge is completed rather
 * than aborted: aborting could throw away edits made to the working tree after the interruption.
 */
async function finishInterruptedSync(target: SyncTarget): Promise<void> {
    const gitDir = join(target.dir, ".git");
    const lock = join(gitDir, "index.lock");
    const lockStat = await stat(lock).catch(() => undefined);
    if (lockStat && Date.now() - lockStat.mtimeMs > STALE_LOCK_MS) await rm(lock, { force: true });
    if (existsSync(join(gitDir, "rebase-merge")) || existsSync(join(gitDir, "rebase-apply"))) {
        throw new Error("a rebase is in progress in the notes repo; finish or abort it by hand");
    }
    if (existsSync(join(gitDir, "MERGE_HEAD"))) {
        target.log?.("finishing an interrupted merge");
        await resolveLeftovers(target);
        await git(target.dir, ["add", "-A"]);
        await git(target.dir, ["commit", "-q", "--no-verify", "-m", `merge(${target.host}): finish interrupted`]);
    }
}

async function commitLocalChanges(target: SyncTarget): Promise<boolean> {
    const { dir } = target;
    await git(dir, ["add", "-A"]);
    const hasHead = (await resolveRef(dir, "HEAD")) !== undefined;
    const changed = (await git(dir, hasHead ? ["diff", "--cached", "--name-only"] : ["ls-files"]))
        .split("\n")
        .filter(Boolean);
    if (changed.length === 0) return false;
    const summary = changed.length === 1 ? changed[0] : `${changed.length} files`;
    await git(dir, ["commit", "-q", "--no-verify", "-m", `sync(${target.host}): ${summary}`]);
    return true;
}

interface UnmergedEntry {
    ours: boolean;
    theirs: boolean;
}

async function listUnmerged(dir: string): Promise<Map<string, UnmergedEntry>> {
    const output = await git(dir, ["ls-files", "-u", "-z"]);
    const entries = new Map<string, UnmergedEntry>();
    for (const record of output.split("\0").filter(Boolean)) {
        const [meta, path] = record.split("\t") as [string, string];
        const stage = meta.split(" ")[2];
        const entry = entries.get(path) ?? { ours: false, theirs: false };
        if (stage === "2") entry.ours = true;
        if (stage === "3") entry.theirs = true;
        entries.set(path, entry);
    }
    return entries;
}

function conflictCopyName(path: string, host: string): string {
    const ext = extname(path);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    return join(dirname(path), `${basename(path, ext)}.conflict-${host}-${stamp}${ext}`);
}

async function writeStage(dir: string, stage: 2 | 3, path: string, to: string): Promise<void> {
    const result = await gitRaw(dir, ["show", `:${stage}:${path}`]);
    if (result.code !== 0) throw new GitError(["show", `:${stage}:${path}`], result);
    await writeFile(join(dir, to), result.stdout);
}

/**
 * Resolves whatever the merge driver could not: modify wins over delete, and if both sides still
 * disagree ours stays in place and theirs is saved next to it. Nothing is ever discarded.
 */
async function resolveLeftovers(target: SyncTarget): Promise<string[]> {
    const { dir } = target;
    const copies: string[] = [];
    for (const [path, entry] of await listUnmerged(dir)) {
        if (entry.ours && entry.theirs) {
            const copy = conflictCopyName(path, target.host);
            await writeStage(dir, 2, path, path);
            await writeStage(dir, 3, path, copy);
            await git(dir, ["add", "--", path, copy]);
            copies.push(copy);
        } else if (entry.ours || entry.theirs) {
            await writeStage(dir, entry.ours ? 2 : 3, path, path);
            await git(dir, ["add", "--", path]);
        } else {
            await git(dir, ["rm", "-q", "--cached", "--ignore-unmatch", "--", path]);
        }
    }
    return copies;
}

async function mergeRemote(target: SyncTarget, remoteRef: string): Promise<{ merged: boolean; copies: string[] }> {
    const { dir } = target;
    const head = await resolveRef(dir, "HEAD");
    const remote = await resolveRef(dir, remoteRef);
    if (!remote) return { merged: false, copies: [] };
    if (!head) {
        // Nothing committed locally yet: adopt the remote branch (refuses to clobber untracked files).
        await git(dir, ["checkout", "-q", "-B", branchOf(target), remote]);
        return { merged: true, copies: [] };
    }
    if ((await gitRaw(dir, ["merge-base", "--is-ancestor", remote, head])).code === 0) {
        return { merged: false, copies: [] };
    }
    const result = await gitRaw(
        dir,
        ["merge", "--no-edit", "--no-verify", "--allow-unrelated-histories", "-m", `merge(${target.host})`, remote],
        { env: { [THEIRS_REF_ENV]: remote } },
    );
    if (result.code === 0) return { merged: true, copies: [] };
    if (!existsSync(join(dir, ".git", "MERGE_HEAD"))) {
        // The merge did not even start (e.g. a file was edited between add and merge): retry later.
        throw new GitError(["merge", remote], result);
    }
    const copies = await resolveLeftovers(target);
    await git(dir, ["commit", "-q", "--no-verify", "--no-edit"]);
    target.log?.(`merged with leftovers resolved, conflict copies: ${copies.join(", ") || "none"}`);
    return { merged: true, copies };
}

/**
 * One full round: commit local edits, merge remote ones, push. Safe to call at any time and
 * repeatedly; a push that loses the race simply goes round again.
 */
export async function syncOnce(target: SyncTarget): Promise<SyncResult> {
    const { dir } = target;
    const branch = branchOf(target);
    const remoteRef = `refs/remotes/${REMOTE}/${branch}`;
    const result: SyncResult = { committed: false, merged: false, pushed: false, conflictCopies: [] };
    await finishInterruptedSync(target);
    for (let attempt = 1; attempt <= MAX_PUSH_ATTEMPTS; attempt++) {
        result.committed = (await commitLocalChanges(target)) || result.committed;
        const fetch = await gitRaw(dir, ["fetch", "-q", REMOTE, `+refs/heads/${branch}:${remoteRef}`], {
            env: target.networkEnv,
        });
        if (fetch.code !== 0 && !/couldn't find remote ref/i.test(fetch.stderr)) {
            throw new GitError(["fetch"], fetch);
        }
        const merge = await mergeRemote(target, remoteRef);
        result.merged = merge.merged || result.merged;
        result.conflictCopies.push(...merge.copies);
        const head = await resolveRef(dir, "HEAD");
        if (!head || head === (await resolveRef(dir, remoteRef))) return result;
        const push = await gitRaw(dir, ["push", "-q", REMOTE, `HEAD:refs/heads/${branch}`], { env: target.networkEnv });
        if (push.code === 0) {
            await git(dir, ["update-ref", remoteRef, head]);
            result.pushed = true;
            return result;
        }
        if (!/rejected|non-fast-forward|fetch first|failed to update ref|cannot lock/i.test(push.stderr)) {
            throw new GitError(["push"], push);
        }
        target.log?.(`push lost a race (attempt ${attempt}), syncing again`);
    }
    throw new Error(`push still rejected after ${MAX_PUSH_ATTEMPTS} attempts`);
}
