import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { judge, mutateArgs, mutateFilter, scopeFromDiff, type MutationReport } from "./mutation-scope.ts";

const accept = mutateFilter(["packages/*/src/**/*.ts", "!packages/sync/src/cli.ts"]);

const diff = `diff --git a/packages/sync/src/sync.ts b/packages/sync/src/sync.ts
index 1..2 100644
--- a/packages/sync/src/sync.ts
+++ b/packages/sync/src/sync.ts
@@ -10,0 +11,2 @@ function a() {
+    const x = 1;
+    return x;
@@ -20 +22 @@
-// old comment
+// new comment
@@ -30,2 +32,0 @@
-    gone();
-    gone();
diff --git a/packages/sync/src/new.ts b/packages/sync/src/new.ts
new file mode 100644
--- /dev/null
+++ b/packages/sync/src/new.ts
@@ -0,0 +1,3 @@
+export const a = 1;
diff --git a/packages/sync/src/cli.ts b/packages/sync/src/cli.ts
--- a/packages/sync/src/cli.ts
+++ b/packages/sync/src/cli.ts
@@ -1 +1 @@
-a
+b
diff --git a/packages/sync/test/sync.test.ts b/packages/sync/test/sync.test.ts
--- a/packages/sync/test/sync.test.ts
+++ b/packages/sync/test/sync.test.ts
@@ -1 +1 @@
-a
+b
`;

describe("scopeFromDiff", () => {
    const scope = scopeFromDiff(diff, accept);

    it("takes added code lines, skipping comment-only hunks and pure deletions", () => {
        assert.deepEqual(scope.get("packages/sync/src/sync.ts"), { whole: false, ranges: [[11, 12]] });
    });

    it("takes new files whole", () => {
        assert.deepEqual(scope.get("packages/sync/src/new.ts"), { whole: true, ranges: [] });
    });

    it("leaves out excluded files and tests", () => {
        assert.equal(scope.has("packages/sync/src/cli.ts"), false);
        assert.equal(scope.has("packages/sync/test/sync.test.ts"), false);
    });

    it("trims inert lines at the edges of a hunk", () => {
        const trimmed = scopeFromDiff(
            `diff --git a/packages/a/src/x.ts b/packages/a/src/x.ts
--- a/packages/a/src/x.ts
+++ b/packages/a/src/x.ts
@@ -1,0 +5,4 @@
+// why
+f();
+
+ * doc
`,
            accept,
        );
        assert.deepEqual(trimmed.get("packages/a/src/x.ts")?.ranges, [[6, 6]]);
    });

    it("renders stryker --mutate entries", () => {
        assert.deepEqual(mutateArgs(scope), ["packages/sync/src/sync.ts:11-12", "packages/sync/src/new.ts"]);
    });
});

describe("judge", () => {
    const mutant = (line: number, status: string) => ({
        id: `${line}${status}`,
        mutatorName: "ConditionalExpression",
        replacement: "true",
        status,
        location: { start: { line, column: 1 } },
    });
    const scope = scopeFromDiff(diff, accept);

    it("counts only mutants inside the scope", () => {
        const report: MutationReport = {
            files: {
                "packages/sync/src/sync.ts": { mutants: [mutant(11, "Killed"), mutant(12, "Timeout"), mutant(40, "Survived")] },
                "packages/git/src/git.ts": { mutants: [mutant(1, "Survived")] },
            },
        };
        const result = judge(report, scope);
        assert.equal(result.total, 2);
        assert.equal(result.score, 100);
        assert.deepEqual(result.blocking, []);
    });

    it("blocks on survivors and on mutants that were never verified", () => {
        const report: MutationReport = {
            files: {
                "packages/sync/src/new.ts": {
                    mutants: [mutant(1, "Killed"), mutant(2, "Survived"), mutant(3, "RuntimeError"), mutant(3, "Ignored")],
                },
            },
        };
        const result = judge(report, scope);
        assert.equal(result.score, 50);
        assert.deepEqual(result.blocking.map(m => m.status), ["Survived", "RuntimeError"]);
        assert.deepEqual(result.counts, { Killed: 1, Survived: 1, RuntimeError: 1, Ignored: 1 });
    });

    it("scores an all-ignored scope as passing", () => {
        const result = judge({ files: { "packages/sync/src/new.ts": { mutants: [mutant(1, "Ignored")] } } }, scope);
        assert.equal(result.score, 100);
    });
});
