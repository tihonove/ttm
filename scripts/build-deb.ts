#!/usr/bin/env node
// Packs the binaries from build-sea.ts into dist/ttm-sync_<version>_{amd64,arm64}.deb.
//
//   node scripts/build-deb.ts --version 1.2.3 [--arch x64,arm64]
//
// The package is just /usr/bin/ttm-sync: `ttm-sync install` writes the user unit itself, and the
// running daemon restarts on its own when an upgrade replaces the binary.
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const DIST = "dist";
const DEB_ARCH: Record<string, string> = { x64: "amd64", arm64: "arm64" };

const { values } = parseArgs({
    options: {
        version: { type: "string" },
        arch: { type: "string", default: "x64,arm64" },
    },
});
const version = values.version;
// Debian versions must start with a digit; build-sea.ts defaults to "dev", which would not do.
if (!version || !/^\d[0-9A-Za-z.+~-]*$/.test(version)) throw new Error(`--version must be a Debian version, got ${version}`);

for (const target of values.arch!.split(",")) {
    const debArch = DEB_ARCH[target];
    if (!debArch) throw new Error(`unknown arch ${target}`);
    const binary = join(DIST, `ttm-sync-linux-${target}`);
    const root = join(DIST, `deb-${debArch}`);
    rmSync(root, { recursive: true, force: true });
    mkdirSync(join(root, "DEBIAN"), { recursive: true });
    mkdirSync(join(root, "usr", "bin"), { recursive: true });
    // dpkg-deb packs the modes as they are on disk, and those come through the umask.
    for (const dir of ["", "usr", "usr/bin"]) chmodSync(join(root, dir), 0o755);
    copyFileSync(binary, join(root, "usr", "bin", "ttm-sync"));
    chmodSync(join(root, "usr", "bin", "ttm-sync"), 0o755);
    const control = [
        "Package: ttm-sync",
        `Version: ${version}`,
        `Architecture: ${debArch}`,
        "Maintainer: Eugene Tihonov <tihonov.ea@gmail.com>",
        `Installed-Size: ${Math.ceil(statSync(binary).size / 1024)}`,
        // The embedded node is the official build: glibc >= 2.28 and the system libstdc++.
        "Depends: git, libc6 (>= 2.28), libstdc++6",
        "Section: utils",
        "Priority: optional",
        "Homepage: https://github.com/tihonove/ttm",
        "Description: ttm notes sync daemon",
        " Keeps a notes directory in sync between machines through the ttm server:",
        " commits local edits, merges remote ones without conflicts, pushes back.",
        "",
    ].join("\n");
    writeFileSync(join(root, "DEBIAN", "control"), control);
    const output = join(DIST, `ttm-sync_${version}_${debArch}.deb`);
    execFileSync("dpkg-deb", ["--root-owner-group", "--build", root, output], { stdio: "inherit" });
    rmSync(root, { recursive: true });
    console.error(`built ${output}`);
}
