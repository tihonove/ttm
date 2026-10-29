import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
    resolve: {
        // Workspace packages resolve to sources next to this config, not via node_modules symlinks:
        // inside Stryker's sandbox the symlinks would point at the original, unmutated files.
        alias: [{ find: /^@ttm\/(git|parser)\/(.*)$/, replacement: `${root}packages/$1/src/$2.ts` }],
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
                statements: 91.18,
                branches: 86.12,
                functions: 91.57,
                lines: 93.34,
            },
            reporter: ["text", "lcov", "json", "json-summary", "text-summary"],
            include: ["packages/*/src/**/*.ts", "apps/*/src/**/*.ts"],
            // Screens are checked in the web build, not unit tests; their logic lives in model.ts.
            exclude: [
                // Process entry points: argv/signals/exit only, the logic they call is tested directly.
                "packages/sync/src/cli.ts",
                "apps/server/src/main.ts",
                "apps/mobile/src/**/*.tsx",
                // Thin wrappers over native modules (keystore, expo-updates) and fetch.
                "apps/mobile/src/api.ts",
                "apps/mobile/src/settings.ts",
                "apps/mobile/src/appUpdate.ts",
            ],
        },
    },
});
