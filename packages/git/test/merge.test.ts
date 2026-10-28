import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { mergeText } from "../src/merge.ts";

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
});
