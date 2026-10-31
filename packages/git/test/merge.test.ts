import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isBinary, isMergeableText, mergeText, TEXT_MERGE_LIMIT } from "../src/merge.ts";

const merge = async (base: string, ours: string, theirs: string) =>
    (await mergeText(Buffer.from(base), Buffer.from(ours), Buffer.from(theirs))).toString("utf8");

describe("mergeText", () => {
    it("takes the only changed side", async () => {
        assert.equal(await merge("a\n", "a\nb\n", "a\n"), "a\nb\n");
        assert.equal(await merge("a\n", "a\n", "x\n"), "x\n");
    });

    it("merges a status change next to an appended line", async () => {
        const base = "NOW:\n- buy milk\n";
        assert.equal(await merge(base, "NOW:\n- buy milk\n- call mom\n", "NOW:\n+ buy milk\n"), "NOW:\n+ buy milk\n- call mom\n");
        assert.equal(await merge(base, "NOW:\n+ buy milk\n", "NOW:\n- buy milk\n- call mom\n"), "NOW:\n+ buy milk\n- call mom\n");
    });

    it("merges changes to neighbouring lines", async () => {
        assert.equal(await merge("- a\n- b\n- c\n", "+ a\n- b\n- c\n", "- a\n+ b\n- c\n"), "+ a\n+ b\n- c\n");
    });

    it("keeps both versions of a line changed on both sides", async () => {
        assert.equal(await merge("x\n- a\ny\n", "x\n+ a\ny\n", "x\n- a (later)\ny\n"), "x\n+ a\n- a (later)\ny\n");
    });

    it("keeps both insertions at the same place, without duplicates", async () => {
        assert.equal(await merge("x\ny\n", "x\n- one\ny\n", "x\n- two\ny\n"), "x\n- one\n- two\ny\n");
        assert.equal(await merge("x\n", "x\n- same\n- one\n", "x\n- same\n- two\n"), "x\n- same\n- one\n- two\n");
    });

    it("applies a deletion on one side and an edit elsewhere on the other", async () => {
        assert.equal(await merge("a\nb\nc\nd\n", "a\nc\nd\n", "a\nb\nc\nd!\n"), "a\nc\nd!\n");
    });

    it("does not glue last lines lacking a newline", async () => {
        assert.equal(await merge("a", "a\nb", "a\nc"), "a\nb\nc\n");
    });

    it("places a deletion that follows other changes", async () => {
        assert.equal(await merge("p\nx\nm\ny\nz\n", "p\nX\nm\nz\n", "p\nx\nm\ny\nz!\n"), "p\nX\nm\nz!\n");
    });

    // ttm-sync has the same merge in Go (packages/sync/internal/merge); it checks this file too.
    it("matches the corpus shared with ttm-sync", async () => {
        const corpus = JSON.parse(readFileSync(new URL("./merge-corpus.json", import.meta.url), "utf8")) as {
            base: string;
            ours: string;
            theirs: string;
            merged: string;
        }[];
        assert.ok(corpus.length > 0);
        for (const { base, ours, theirs, merged } of corpus) assert.equal(await merge(base, ours, theirs), merged);
    });

    it("hands a change too large for the in-process diff to git's union merge", async () => {
        const numbered = (prefix: string) => Array.from({ length: 2100 }, (_, i) => `${prefix}${i}\n`).join("");
        const merged = await merge(`top\n${numbered("b")}end\n`, `top\n${numbered("o")}end\n`, `top\n${numbered("t")}end\n`);
        assert.equal(merged, `top\n${numbered("o")}${numbered("t")}end\n`);
    });
});

describe("git's union merge", () => {
    const numbered = (prefix: string) => Array.from({ length: 2100 }, (_, i) => `${prefix}${i}\n`).join("");
    const huge = () => merge(numbered("b"), numbered("o"), numbered("t"));

    /** Runs with a fake git first on PATH and its own temp dir, returned for a look at what is left there. */
    async function withFakeGit(script: string, run: (temp: string) => Promise<void>): Promise<void> {
        const dir = mkdtempSync(join(tmpdir(), "ttm-fake-git-"));
        const { PATH, TMPDIR } = process.env;
        try {
            writeFileSync(join(dir, "git"), `#!/bin/sh\n${script}\n`);
            chmodSync(join(dir, "git"), 0o755);
            process.env.PATH = `${dir}:${PATH}`;
            process.env.TMPDIR = dir;
            await run(dir);
        } finally {
            process.env.PATH = PATH;
            if (TMPDIR === undefined) delete process.env.TMPDIR;
            else process.env.TMPDIR = TMPDIR;
            rmSync(dir, { recursive: true, force: true });
        }
    }
    const leftovers = (dir: string) => readdirSync(dir).filter(name => name.startsWith("ttm-merge-"));

    it("takes a conflict count just below the error range as success and cleans up", () =>
        withFakeGit("echo merged; exit 127", async dir => {
            assert.equal(await huge(), "merged\n");
            assert.deepEqual(leftovers(dir), []);
        }));

    it("fails on the lowest error code, says why and cleans up", () =>
        withFakeGit("echo oops >&2; exit 128", async dir => {
            await assert.rejects(huge(), { message: "git merge-file failed: oops\n" });
            assert.deepEqual(leftovers(dir), []);
        }));

    it("fails when git is killed by a signal", () =>
        withFakeGit("kill -9 $$", async () => {
            await assert.rejects(huge(), /git merge-file failed/);
        }));
});

describe("isMergeableText", () => {
    it("takes text up to the size limit", () => {
        const limit = Buffer.alloc(TEXT_MERGE_LIMIT, "a");
        assert.equal(isMergeableText(limit, Buffer.from("x")), true);
        assert.equal(isMergeableText(Buffer.from("x"), Buffer.alloc(TEXT_MERGE_LIMIT + 1, "a")), false);
    });

    it("refuses binary content", () => {
        assert.equal(isMergeableText(Buffer.from("x"), Buffer.from([97, 0])), false);
    });
});

describe("isBinary", () => {
    it("looks for a NUL in the first 8000 bytes only", () => {
        const content = Buffer.alloc(8001, "a");
        assert.equal(isBinary(content), false);
        content[7999] = 0;
        assert.equal(isBinary(content), true);
        content[7999] = 97;
        content[8000] = 0;
        assert.equal(isBinary(content), false);
    });
});
