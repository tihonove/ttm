import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, gitRaw, GitError, resolveRef } from "../src/git.ts";

async function withRepo(run: (dir: string) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), "ttm-git-test-"));
    try {
        await git(dir, ["init", "-q", "-b", "main"]);
        await run(dir);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

/** Runs with a script named git first on PATH. */
async function withFakeGit(script: string, run: (dir: string) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), "ttm-fake-git-"));
    const path = process.env.PATH;
    try {
        await writeFile(join(dir, "git"), `#!/bin/sh\n${script}\n`);
        await chmod(join(dir, "git"), 0o755);
        process.env.PATH = `${dir}:${path}`;
        await run(dir);
    } finally {
        process.env.PATH = path;
        await rm(dir, { recursive: true, force: true });
    }
}

describe("git", () => {
    it("reports a failed command with its exit code and message", () =>
        withRepo(async dir => {
            const error = await git(dir, ["rev-parse", "--verify", "nope"]).catch((e: unknown) => e);
            assert.ok(error instanceof GitError);
            assert.equal(error.result.code, 128);
            assert.equal(error.message, "git rev-parse --verify nope exited with 128: fatal: Needed a single revision");
        }));

    it("passes extra env and input through, without translating messages", () =>
        withRepo(async dir => {
            const oid = await git(dir, ["hash-object", "-w", "--stdin"], { input: "text\n" });
            assert.equal((await gitRaw(dir, ["cat-file", "-p", oid])).stdout.toString(), "text\n");
            const { stderr } = await gitRaw(dir, ["rev-parse", "--verify", "nope"], { env: { LANGUAGE: "ru" } });
            assert.match(stderr, /Needed a single revision/);
        }));

    it("forces untranslated, non-interactive git, unless told otherwise", () =>
        withFakeGit(`echo "$LC_ALL $GIT_TERMINAL_PROMPT $EXTRA"`, async dir => {
            const run = async (env?: NodeJS.ProcessEnv) => (await gitRaw(dir, [], { env })).stdout.toString();
            assert.equal(await run(), "C 0 \n");
            assert.equal(await run({ LC_ALL: "ru_RU", EXTRA: "x" }), "ru_RU 0 x\n");
        }));

    it("gives git an empty stdin by default", () =>
        withFakeGit("cat", async dir => {
            assert.equal((await gitRaw(dir, [])).stdout.toString(), "");
        }));

    it("survives git exiting without reading its input", () =>
        withFakeGit("exit 0", async dir => {
            assert.equal((await gitRaw(dir, [], { input: Buffer.alloc(4 * 1024 * 1024) })).code, 0);
        }));

    it("reports a git killed by a signal as code -1", () =>
        withFakeGit("kill -9 $$", async dir => {
            assert.equal((await gitRaw(dir, [])).code, -1);
        }));

    it("rejects when git cannot run at all", async () => {
        await assert.rejects(gitRaw(join(tmpdir(), "ttm-no-such-dir"), ["status"]));
    });

    it("resolves a ref to its commit, undefined when absent", () =>
        withRepo(async dir => {
            assert.equal(await resolveRef(dir, "HEAD"), undefined);
            await git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x"]);
            assert.equal(await resolveRef(dir, "HEAD"), await git(dir, ["rev-parse", "HEAD"]));
        }));
});
