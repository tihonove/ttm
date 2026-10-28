import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
    resolve: {
        // Workspace packages resolve to sources next to this config, not via node_modules symlinks:
        // inside Stryker's sandbox the symlinks would point at the original, unmutated files.
        alias: [{ find: /^@ttm\/git\/(.*)$/, replacement: `${root}packages/git/src/$1.ts` }],
    },
    test: {
        include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts", "scripts/**/*.test.ts"],
        // Sync tests drive real git processes and wait for daemons.
        testTimeout: 30_000,
        hookTimeout: 30_000,
        coverage: {
            provider: "v8",
            skipFull: true,
            reportOnFailure: true,
            // Ratchet: autoUpdate raises the numbers when coverage grows; commit them.
            thresholds: {
                autoUpdate: true,
                statements: 82.36,
                branches: 68.58,
                functions: 82.07,
                lines: 85.77,
            },
            reporter: ["text", "lcov", "json", "json-summary", "text-summary"],
            include: ["packages/*/src/**/*.ts", "apps/*/src/**/*.ts"],
            exclude: [
                // Process entry points: argv/signals/exit only, the logic they call is tested directly.
                "packages/sync/src/cli.ts",
                "apps/server/src/main.ts",
            ],
        },
    },
});
