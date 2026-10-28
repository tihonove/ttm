#!/usr/bin/env node
// Builds ttm-sync as single executables with node embedded: dist/ttm-sync-linux-{x64,arm64}.
//
//   node scripts/build-sea.ts [--version 1.2.3] [--arch x64,arm64]
//
// The blob is made by a node of the same version as the binaries it is injected into; without
// a startup snapshot or code cache it is architecture-independent, so one blob serves both.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

/** Node release embedded into the binary; bump deliberately. */
const NODE_VERSION = "24.22.2";
const SENTINEL = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
const DIST = "dist";
const CACHE = join(DIST, ".node-cache");

const { values } = parseArgs({
    options: {
        version: { type: "string", default: "dev" },
        arch: { type: "string", default: "x64,arm64" },
    },
});
const arches = values.arch!.split(",");

function run(command: string, args: string[]): void {
    console.error(`> ${command} ${args.join(" ")}`);
    execFileSync(command, args, { stdio: "inherit" });
}

/** Official node binary for an architecture, downloaded once and checked against SHASUMS256. */
async function nodeBinary(target: string): Promise<string> {
    const name = `node-v${NODE_VERSION}-linux-${target}`;
    const binary = join(CACHE, name, "bin", "node");
    if (existsSync(binary)) return binary;
    mkdirSync(CACHE, { recursive: true });
    const base = `https://nodejs.org/dist/v${NODE_VERSION}`;
    const sums = await (await fetch(`${base}/SHASUMS256.txt`)).text();
    const expected = sums.split("\n").find(line => line.endsWith(` ${name}.tar.xz`))?.split(" ")[0];
    if (!expected) throw new Error(`no checksum for ${name}`);
    const archive = Buffer.from(await (await fetch(`${base}/${name}.tar.xz`)).arrayBuffer());
    const actual = createHash("sha256").update(archive).digest("hex");
    if (actual !== expected) throw new Error(`checksum mismatch for ${name}: ${actual}`);
    const archivePath = join(CACHE, `${name}.tar.xz`);
    writeFileSync(archivePath, archive);
    run("tar", ["-xJf", archivePath, "-C", CACHE, `${name}/bin/node`]);
    return binary;
}

mkdirSync(DIST, { recursive: true });
const bundle = join(DIST, "ttm-sync.cjs");
run("npx", [
    "esbuild",
    "packages/sync/src/cli.ts",
    "--bundle",
    "--platform=node",
    "--format=cjs",
    `--target=node${NODE_VERSION.split(".")[0]}`,
    `--define:__TTM_VERSION__=${JSON.stringify(values.version)}`,
    // Only the development fallback for the merge driver reads import.meta.url; the binary never does.
    "--log-override:empty-import-meta=silent",
    `--outfile=${bundle}`,
]);

const blob = join(DIST, "sea-prep.blob");
const seaConfig = join(DIST, "sea-config.json");
writeFileSync(seaConfig, JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true }));
const hostArch = arch() === "arm64" ? "arm64" : "x64";
run(await nodeBinary(hostArch), ["--experimental-sea-config", seaConfig]);

for (const target of arches) {
    const output = join(DIST, `ttm-sync-linux-${target}`);
    copyFileSync(await nodeBinary(target), output);
    chmodSync(output, 0o755);
    run("npx", ["postject", output, "NODE_SEA_BLOB", blob, "--sentinel-fuse", SENTINEL]);
    if (target === hostArch) {
        const reported = execFileSync(output, ["--version"], { encoding: "utf8" }).trim();
        if (reported !== values.version) throw new Error(`smoke test: ${output} --version printed ${reported}`);
        console.error(`smoke test ok: ${output} --version = ${reported}`);
    }
    const size = (readFileSync(output).length / 1024 / 1024).toFixed(0);
    console.error(`built ${output} (${size} MB)`);
}
