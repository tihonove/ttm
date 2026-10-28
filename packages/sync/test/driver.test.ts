import { afterEach, beforeEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "@ttm/git/git";
import { TEXT_MERGE_LIMIT } from "@ttm/git/merge";
import { runDriver } from "../src/driver.ts";

describe("runDriver", () => {
    let dir: string;
    const files = () => ({ basePath: join(dir, "O"), oursPath: join(dir, "A"), theirsPath: join(dir, "B") });

    async function stage(base: string | Buffer, ours: string | Buffer, theirs: string | Buffer) {
        const { basePath, oursPath, theirsPath } = files();
        await writeFile(basePath, base);
        await writeFile(oursPath, ours);
        await writeFile(theirsPath, theirs);
    }

    /** Commits `path` on HEAD and on a side branch with the given commit times. */
    async function history(path: string, oursTime: number, theirsTime: number) {
        const env = (time: number) => ({ GIT_COMMITTER_DATE: `@${time} +0000`, GIT_AUTHOR_DATE: `@${time} +0000` });
        await git(dir, ["init", "-q", "-b", "main"]);
        await git(dir, ["config", "user.name", "t"]);
        await git(dir, ["config", "user.email", "t@t"]);
        await writeFile(join(dir, path), "base");
        await git(dir, ["add", path]);
        await git(dir, ["commit", "-qm", "base"], { env: env(1000) });
        await git(dir, ["branch", "theirs"]);
        await writeFile(join(dir, path), "ours");
        await git(dir, ["commit", "-qam", "ours"], { env: env(oursTime) });
        await git(dir, ["checkout", "-q", "theirs"]);
        await writeFile(join(dir, path), "theirs");
        await git(dir, ["commit", "-qam", "theirs"], { env: env(theirsTime) });
        await git(dir, ["checkout", "-q", "main"]);
    }

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), "ttm-driver-test-"));
    });
    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    it("merges text into ours", async () => {
        await stage("- a\n- b\n", "+ a\n- b\n", "- a\n- b\n- c\n");
        await runDriver({ ...files(), path: "Home.md", repoDir: dir, theirsRef: undefined });
        assert.equal(await readFile(files().oursPath, "utf8"), "+ a\n- b\n- c\n");
    });

    it("takes theirs for a binary file changed later on their side", async () => {
        await history("scan.pdf", 2000, 3000);
        await stage(Buffer.from([0, 1]), Buffer.from([0, 2]), Buffer.from([0, 3]));
        await runDriver({ ...files(), path: "scan.pdf", repoDir: dir, theirsRef: "theirs" });
        assert.deepEqual(await readFile(files().oursPath), Buffer.from([0, 3]));
    });

    it("keeps ours for a binary file changed later on our side", async () => {
        await history("scan.pdf", 3000, 2000);
        await stage(Buffer.from([0, 1]), Buffer.from([0, 2]), Buffer.from([0, 3]));
        await runDriver({ ...files(), path: "scan.pdf", repoDir: dir, theirsRef: "theirs" });
        assert.deepEqual(await readFile(files().oursPath), Buffer.from([0, 2]));
    });

    it("keeps ours for a binary file when both sides changed at the same second", async () => {
        await history("scan.pdf", 3000, 3000);
        await stage(Buffer.from([0, 1]), Buffer.from([0, 2]), Buffer.from([0, 3]));
        await runDriver({ ...files(), path: "scan.pdf", repoDir: dir, theirsRef: "theirs" });
        assert.deepEqual(await readFile(files().oursPath), Buffer.from([0, 2]));
    });

    it("treats a text file over the size limit like a binary one", async () => {
        await history("big.txt", 2000, 3000);
        const big = (c: string) => `${c.repeat(TEXT_MERGE_LIMIT)}\n`;
        await stage(big("o"), big("a"), big("b"));
        await runDriver({ ...files(), path: "big.txt", repoDir: dir, theirsRef: "theirs" });
        assert.equal(await readFile(files().oursPath, "utf8"), big("b"));
    });

    it("keeps ours for a binary file when the other side is unknown", async () => {
        await stage(Buffer.from([0, 1]), Buffer.from([0, 2]), Buffer.from([0, 3]));
        await runDriver({ ...files(), path: "scan.pdf", repoDir: dir, theirsRef: undefined });
        assert.deepEqual(await readFile(files().oursPath), Buffer.from([0, 2]));
    });
});
