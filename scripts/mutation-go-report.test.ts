import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { acceptGo, formatGate, fromGoReport, gatePassed, judge, type GoMutant, type Scope } from "./mutation-scope.ts";

const FILE = "packages/sync/internal/merge/merge.go";

function mutant(name: string, original: string, mutated: string): GoMutant {
    return { mutator: { mutatorName: name, originalSourceCode: original, mutatedSourceCode: mutated, originalFilePath: "./x.go" } };
}

describe("acceptGo", () => {
    it("takes the module's internal sources only", () => {
        assert.equal(acceptGo(FILE), true);
        assert.equal(acceptGo("packages/sync/internal/merge/merge_test.go"), false);
        assert.equal(acceptGo("packages/sync/main.go"), false);
        assert.equal(acceptGo("tools/mutation/osutil/copy.go"), false);
    });
});

describe("fromGoReport", () => {
    const report = fromGoReport(
        {
            killed: [mutant("branch/if", "a\nb\nc\n", "a\nX\nc\n")],
            escaped: [mutant("branch/else", "a\nb\nc\n", "a\nb\n  Y\n")],
            timeouted: [mutant("loop/condition", "a\n", "Z\n")],
            errored: null,
        },
        FILE,
    );
    const mutants = report.files[FILE]!.mutants;

    it("maps the outcomes to Stryker statuses", () => {
        assert.deepEqual(mutants.map(m => m.status), ["Killed", "Timeout", "Survived"]);
    });

    it("locates a mutant by the first line that differs", () => {
        assert.deepEqual(mutants.map(m => m.location.start.line), [2, 1, 3]);
        assert.deepEqual(mutants.map(m => m.replacement), ["X", "Z", "Y"]);
    });

    it("feeds the common gate: a survivor in scope is blocking, out of scope it is not", () => {
        const scope = (start: number, end: number): Scope => new Map([[FILE, { whole: false, ranges: [[start, end]] }]]);
        const inside = judge(report, scope(3, 3));
        assert.equal(gatePassed(inside, 100), false);
        assert.match(formatGate(inside, 100), /branch\/else/);
        assert.equal(gatePassed(judge(report, scope(1, 2)), 100), true);
    });

    it("treats errored mutants as unverified, not as passed", () => {
        const errored = fromGoReport({ killed: null, escaped: null, timeouted: null, errored: [mutant("x", "a\n", "b\n")] }, FILE);
        const result = judge(errored, new Map([[FILE, { whole: true, ranges: [] }]]));
        assert.equal(result.blocking.length, 1);
        assert.equal(gatePassed(result, 100), false);
    });
});
