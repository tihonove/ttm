import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { parse } from "@ttm/parser/parse";
import { buildSections, countOpen, fileTitle, parsePairing, type TodosResponse } from "../src/model.ts";

const response = (files: Record<string, string>): TodosResponse => ({
    head: "abc",
    files: Object.entries(files).map(([path, text]) => ({ path, nodes: parse(text).nodes })),
});

const shape = (sections: ReturnType<typeof buildSections>) =>
    sections.map(s => [s.file, s.title, s.data.map(r => (r.kind === "task" ? `${r.marker} ${r.text}` : `~ ${r.text}`))]);

describe("buildSections", () => {
    const todos = response({
        "Home.md": "# NOW\n- a\n+ b\n  - under done\n- c\n  + c1\n\n# NEXT:\n",
        "Diode.md": "Intro text\n\nFirstRelease:\n  + shipped\n  - pending\n",
    });

    it("shows everything with the all filter, empty sections included", () => {
        assert.deepEqual(shape(buildSections(todos, "all")), [
            ["Home", "NOW", ["- a", "+ b", "- under done", "- c", "+ c1"]],
            ["Home", "NEXT", []],
            ["Diode", "", ["~ Intro text"]],
            ["Diode", "FirstRelease", ["+ shipped", "- pending"]],
        ]);
    });

    it("hides finished tasks and what is nested under them, keeps text", () => {
        assert.deepEqual(shape(buildSections(todos, "open")), [
            ["Home", "NOW", ["- a", "- c"]],
            ["Diode", "", ["~ Intro text"]],
            ["Diode", "FirstRelease", ["- pending"]],
        ]);
    });

    it("counts open tasks whatever the filter", () => {
        assert.deepEqual(buildSections(todos, "all").map(s => s.open), [3, 0, 0, 1]);
        assert.equal(countOpen(buildSections(todos, "open")), 4);
    });

    it("hides cancelled tasks like done ones and keeps questions", () => {
        const sections = buildSections(response({ "A.md": "x dropped\n? maybe\n" }), "open");
        assert.deepEqual(shape(sections), [["A", "", ["? maybe"]]]);
    });

    it("gives rows keys unique across files", () => {
        const keys = buildSections(todos, "all").flatMap(s => s.data.map(r => r.key));
        assert.equal(new Set(keys).size, keys.length);
    });
});

describe("fileTitle", () => {
    it("drops the notes extension only", () => {
        assert.deepEqual(["Home.md", "Archive.todo", "notes.txt"].map(fileTitle), ["Home", "Archive", "notes.txt"]);
    });
});

describe("parsePairing", () => {
    it("reads server and token from a pairing code", () => {
        const data = `ttm://pair?server=${encodeURIComponent("https://ttm.tihonove.dev")}&token=abc123`;
        assert.deepEqual(parsePairing(data), { server: "https://ttm.tihonove.dev", token: "abc123" });
    });

    it("rejects other QR codes and incomplete or non-http pairings", () => {
        for (const data of ["https://example.com", "ttm://pair?server=https://x", "ttm://pair?token=t", "ttm://pair?server=file:///x&token=t", "ttm://pair?server=%E0%A4%A&token=t"]) {
            assert.equal(parsePairing(data), null, data);
        }
    });
});
