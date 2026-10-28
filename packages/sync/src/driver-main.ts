#!/usr/bin/env node
// Entry point git spawns as the `ttm` merge driver: `driver-main.ts %O %A %B %P`.
import { runDriver, THEIRS_REF_ENV } from "./driver.ts";

const [basePath, oursPath, theirsPath, path] = process.argv.slice(2);
if (!basePath || !oursPath || !theirsPath || !path) {
    console.error("usage: driver-main.ts %O %A %B %P");
    process.exit(2);
}
// git runs merge drivers from the top of the working tree.
const input = { basePath, oursPath, theirsPath, path, repoDir: process.cwd(), theirsRef: process.env[THEIRS_REF_ENV] };
runDriver(input).catch(error => {
    // The path stays unmerged; the daemon keeps ours and saves theirs as a conflict copy.
    console.error(`ttm merge driver: ${path}: ${error}`);
    process.exitCode = 1;
});
