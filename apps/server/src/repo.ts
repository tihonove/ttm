import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { git, gitRaw, resolveRef } from "@ttm/git/git";
import { isMergeableText, mergeText } from "@ttm/git/merge";

const BRANCH_REF = "refs/heads/main";
const ZERO_OID = "0".repeat(40);
const MAX_WRITE_ATTEMPTS = 10;

/** Repo-relative path from user input, or undefined if it tries to escape or touch .git. */
export function safePath(raw: string | null): string | undefined {
    if (!raw) return undefined;
    const normalized = posix.normalize(raw).replace(/^\/+/, "");
    if (!normalized || normalized.startsWith("..") || normalized.split("/").includes(".git")) return undefined;
    return normalized;
}

export interface FileEntry {
    path: string;
    size: number;
}

export interface WriteRequest {
    path: string;
    content: Buffer;
    /** Commit the client's edit is based on; lets the server merge in changes made since. */
    baseCommit?: string;
    message: string;
}

/**
 * The server's only state: a bare git repository. Reads go straight to git objects, writes are
 * commits created with plumbing and published with a compare-and-swap on the branch ref, so they
 * interleave safely with pushes from the sync daemons.
 */
export class NotesRepo {
    readonly path: string;

    constructor(path: string) {
        this.path = path;
    }

    async init(): Promise<void> {
        if (!existsSync(join(this.path, "HEAD"))) {
            await git(tmpdir(), ["init", "-q", "--bare", "-b", "main", this.path]);
        }
        const config: [string, string][] = [
            ["http.receivepack", "true"],
            ["http.uploadpack", "true"],
            // History is the backup: nobody may rewrite or delete it.
            ["receive.denyNonFastForwards", "true"],
            ["receive.denyDeletes", "true"],
            ["core.logAllRefUpdates", "always"],
            ["gc.auto", "256"],
        ];
        for (const [key, value] of config) await git(this.path, ["config", key, value]);
    }

    head(): Promise<string | undefined> {
        return resolveRef(this.path, BRANCH_REF);
    }

    async listFiles(commit?: string): Promise<FileEntry[]> {
        const ref = commit ?? (await this.head());
        if (!ref) return [];
        const output = await git(this.path, ["ls-tree", "-r", "-z", "--long", ref]);
        return output
            .split("\0")
            .filter(Boolean)
            .map(record => {
                const [meta, path] = record.split("\t") as [string, string];
                const size = Number(meta.trim().split(/\s+/)[3]);
                return { path, size: Number.isFinite(size) ? size : 0 };
            });
    }

    /** Returns file content at a commit (head by default), or undefined if the file is absent. */
    async readFile(path: string, commit?: string): Promise<Buffer | undefined> {
        const ref = commit ?? (await this.head());
        if (!ref) return undefined;
        const result = await gitRaw(this.path, ["cat-file", "blob", `${ref}:${path}`]);
        return result.code === 0 ? result.stdout : undefined;
    }

    async writeFile(request: WriteRequest): Promise<{ commit: string; merged: boolean }> {
        const base = request.baseCommit ? await this.readFile(request.path, request.baseCommit) : undefined;
        for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt++) {
            const head = await this.head();
            const current = head ? await this.readFile(request.path, head) : undefined;
            let content = request.content;
            let merged = false;
            if (request.baseCommit && current && !current.equals(base ?? Buffer.alloc(0))) {
                // Someone changed the file after the client read it: merge instead of overwriting.
                if (isMergeableText(base ?? Buffer.alloc(0), current, content)) {
                    content = await mergeText(base ?? Buffer.alloc(0), current, content);
                    merged = true;
                }
            }
            if (current?.equals(content)) return { commit: head!, merged };
            const commit = await this.commitFile(head, request.path, content, request.message);
            const update = await gitRaw(this.path, ["update-ref", BRANCH_REF, commit, head ?? ZERO_OID]);
            if (update.code === 0) return { commit, merged };
        }
        throw new Error(`could not update ${BRANCH_REF} after ${MAX_WRITE_ATTEMPTS} attempts`);
    }

    private async commitFile(parent: string | undefined, path: string, content: Buffer, message: string) {
        const blob = await git(this.path, ["hash-object", "-w", "--stdin"], { input: content });
        const dir = await mkdtemp(join(tmpdir(), "ttm-index-"));
        const env = {
            GIT_INDEX_FILE: join(dir, "index"),
            GIT_AUTHOR_NAME: "ttm-server",
            GIT_AUTHOR_EMAIL: "ttm-server@tihonove.dev",
            GIT_COMMITTER_NAME: "ttm-server",
            GIT_COMMITTER_EMAIL: "ttm-server@tihonove.dev",
        };
        try {
            if (parent) await git(this.path, ["read-tree", parent], { env });
            await git(this.path, ["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`], { env });
            const tree = await git(this.path, ["write-tree"], { env });
            return await git(this.path, ["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", message], { env });
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    }
}
