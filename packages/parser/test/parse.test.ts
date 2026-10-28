import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse, render, type TaskNode } from "../src/parse.ts";

const tasks = (source: string) => parse(source).nodes.filter((n): n is TaskNode => n.kind === "task");

describe("parse", () => {
    it("reads markdown headings and colon labels as sections", () => {
        const doc = parse("# NOW\n- a\nNEXT:\n- b\nFirstRelease:\n  + c\nBUGS INBOX:\n");
        assert.deepEqual(
            doc.nodes.filter(n => n.kind === "section").map(n => n.kind === "section" && n.title),
            ["NOW", "NEXT", "FirstRelease", "BUGS INBOX"],
        );
        assert.deepEqual(tasks("# NOW\n- a\nNEXT:\n- b\n").map(t => t.section), ["NOW", "NEXT"]);
        assert.equal(parse("# INBOX:\n").nodes[0]!.kind === "section" && (parse("# INBOX:\n").nodes[0] as { title: string }).title, "INBOX");
    });

    it("maps markers to statuses", () => {
        assert.deepEqual(
            tasks("- a\n* b\n+ c\nx d\nX e\n? f\n").map(t => [t.marker, t.status, t.text]),
            [
                ["-", "open", "a"],
                ["*", "open", "b"],
                ["+", "done", "c"],
                ["x", "cancelled", "d"],
                ["X", "cancelled", "e"],
                ["?", "question", "f"],
            ],
        );
    });

    it("nests tasks by indentation", () => {
        const list = tasks("- a\n  - b\n      + c\n  - d\n- e\n\t- f\n");
        assert.deepEqual(list.map(t => [t.text, t.depth, t.parentLine]), [
            ["a", 0, undefined],
            ["b", 1, 1],
            ["c", 2, 2],
            ["d", 1, 1],
            ["e", 0, undefined],
            ["f", 1, 5],
        ]);
        assert.equal(list[5]!.indent, 4);
    });

    it("starts nesting afresh in every section", () => {
        const list = tasks("A:\n    - a\nB:\n- b\n");
        assert.deepEqual(list.map(t => [t.depth, t.parentLine]), [
            [0, undefined],
            [0, undefined],
        ]);
    });

    it("keeps prose, links and odd lines as text instead of dropping them", () => {
        const doc = parse("Отлично. Смотри, вот длинный абзац -- без маркера\n-без пробела\nhttps://x.y/z\nx\n");
        assert.deepEqual(doc.nodes.map(n => n.kind), ["text", "text", "text", "text"]);
    });

    it("does not take a long line ending with a colon for a section", () => {
        const line = `${"слово ".repeat(12)}такое:`;
        assert.equal(parse(`${line}\n`).nodes[0]!.kind, "text");
    });

    it("treats lines of whitespace, including no-break spaces, as blank", () => {
        assert.deepEqual(parse("a\n   \n\u00a0\n").nodes.map(n => n.kind), ["text", "blank", "blank"]);
    });

    it("attaches text to its section", () => {
        const node = parse("NOW:\nnote\n").nodes[1]!;
        assert.equal(node.kind === "text" && node.section, "NOW");
    });

    for (const [name, source] of [
        ["empty", ""],
        ["only newline", "\n"],
        ["no final newline", "- a\n- b"],
        ["crlf", "NOW:\r\n- a\r\n\r\n"],
        ["trailing spaces kept", "- a  \n  \n"],
    ] as const) {
        it(`renders back byte for byte: ${name}`, () => {
            assert.equal(render(parse(source)), source);
        });
    }
});

// The real notes never go into this public repo; the check runs where they exist.
const notes = join(homedir(), "Documents", "Notes");
// skipIf still runs the describe body, so the listing itself must not touch a missing folder.
const noteFiles = existsSync(notes) ? readdirSync(notes).filter(f => /\.(md|todo)$/.test(f)) : [];
describe.skipIf(noteFiles.length === 0)("parse on the real notes", () => {
    for (const name of noteFiles) {
        it(`round-trips ${name} and sees every line`, () => {
            const source = readFileSync(join(notes, name), "utf8");
            const doc = parse(source);
            assert.equal(render(doc), source);
            const lines = source === "" ? 0 : source.split("\n").length - (source.endsWith("\n") ? 1 : 0);
            assert.equal(doc.nodes.length, lines);
        });
    }
});
