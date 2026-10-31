#!/usr/bin/env node
// Builds ttm-sync as static binaries: dist/ttm-sync-linux-{x64,arm64}.
//
//   node scripts/build-bin.ts [--version 1.2.3] [--arch x64,arm64]
import { execFileSync } from "node:child_process";
import { mkdirSync, statSync } from "node:fs";
import { arch } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

const DIST = resolve("dist");
const GO_ARCH: Record<string, string> = { x64: "amd64", arm64: "arm64" };

const { values } = parseArgs({
    options: {
        version: { type: "string", default: "dev" },
        arch: { type: "string", default: "x64,arm64" },
    },
});

mkdirSync(DIST, { recursive: true });
for (const target of values.arch!.split(",")) {
    const goArch = GO_ARCH[target];
    if (!goArch) throw new Error(`unknown arch ${target}`);
    const output = `${DIST}/ttm-sync-linux-${target}`;
    execFileSync("go", ["-C", "packages/sync", "build", "-trimpath", "-ldflags", `-s -w -X main.version=${values.version}`, "-o", output, "."], {
        stdio: "inherit",
        env: { ...process.env, CGO_ENABLED: "0", GOOS: "linux", GOARCH: goArch },
    });
    if (target === arch()) {
        const reported = execFileSync(output, ["--version"], { encoding: "utf8" }).trim();
        if (reported !== values.version) throw new Error(`smoke test: ${output} --version printed ${reported}`);
        console.error(`smoke test ok: ${output} --version = ${reported}`);
    }
    console.error(`built ${output} (${(statSync(output).size / 1024 / 1024).toFixed(1)} MB)`);
}
