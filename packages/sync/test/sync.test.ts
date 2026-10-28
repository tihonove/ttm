import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "@ttm/git/git";
import { prepareRepo, setRemote, syncOnce, type SyncTarget } from "../src/sync.ts";

async function makeWorld(hosts: string[]) {
    const root = await mkdtemp(join(tmpdir(), "ttm-sync-test-"));
    const remote = join(root, "remote.git");
    await git(root, ["init", "-q", "--bare", "-b", "main", remote]);
    const machines: Record<string, SyncTarget> = {};
    for (const host of hosts) {
        const dir = join(root, host);
        await mkdir(dir);
        const target: SyncTarget = { dir, host };
        await prepareRepo(target);
        await setRemote(dir, remote);
        machines[host] = target;
    }
    return { root, machines, cleanup: () => rm(root, { recursive: true, force: true }) };
}

const read = (t: SyncTarget, path: string) => readFile(join(t.dir, path), "utf8");
const write = (t: SyncTarget, path: string, content: string | Buffer) => writeFile(join(t.dir, path), content);

async function listFiles(dir: string, prefix = ""): Promise<string[]> {
    const out: string[] = [];
    for (const entry of await readdir(join(dir, prefix), { withFileTypes: true })) {
        if (entry.name === ".git") continue;
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) out.push(...(await listFiles(dir, rel)));
        else out.push(rel);
    }
    return out.sort();
}

describe("syncOnce", () => {
    it("propagates a new file to another machine", async () => {
        const { machines: { a, b }, cleanup } = await makeWorld(["a", "b"]);
        try {
            await write(a!, "Home.md", "- task\n");
            assert.equal((await syncOnce(a!)).pushed, true);
            await syncOnce(b!);
            assert.equal(await read(b!, "Home.md"), "- task\n");
        } finally {
            await cleanup();
        }
    });

    it("fast-forwards when only the other side changed, even with merge.ff=no globally", async () => {
        const { root, machines: { a, b }, cleanup } = await makeWorld(["a", "b"]);
        try {
            const globalConfig = join(root, "global.gitconfig");
            await writeFile(globalConfig, "[merge]\n\tff = no\n");
            process.env.GIT_CONFIG_GLOBAL = globalConfig;
            await write(a!, "Home.md", "- one\n");
            await syncOnce(a!);
            await syncOnce(b!);
            await write(a!, "Home.md", "- one\n- two\n");
            await syncOnce(a!);
            await syncOnce(b!);
            assert.equal(await git(b!.dir, ["rev-parse", "HEAD"]), await git(a!.dir, ["rev-parse", "HEAD"]));
        } finally {
            delete process.env.GIT_CONFIG_GLOBAL;
            await cleanup();
        }
    });

    it("merges edits of the same line from two machines without markers, keeping both", async () => {
        const { machines: { a, b }, cleanup } = await makeWorld(["a", "b"]);
        try {
            await write(a!, "Home.md", "NOW:\n- one\n- two\n");
            await syncOnce(a!);
            await syncOnce(b!);
            await write(a!, "Home.md", "NOW:\n+ one\n- two\n");
            await write(b!, "Home.md", "NOW:\n- one (edited)\n- two\n");
            await syncOnce(a!);
            await syncOnce(b!);
            await syncOnce(a!);
            const merged = await read(a!, "Home.md");
            assert.equal(merged, await read(b!, "Home.md"));
            assert.doesNotMatch(merged, /<<<<<<<|>>>>>>>/);
            assert.match(merged, /^\+ one$/m);
            assert.match(merged, /^- one \(edited\)$/m);
        } finally {
            await cleanup();
        }
    });

    it("merges non-overlapping edits cleanly", async () => {
        const { machines: { a, b }, cleanup } = await makeWorld(["a", "b"]);
        try {
            await write(a!, "Home.md", "NOW:\n- one\n\nNEXT:\n- two\n");
            await syncOnce(a!);
            await syncOnce(b!);
            await write(a!, "Home.md", "NOW:\n+ one\n\nNEXT:\n- two\n");
            await write(b!, "Home.md", "NOW:\n- one\n\nNEXT:\n- two\n- three\n");
            await syncOnce(a!);
            await syncOnce(b!);
            assert.equal(await read(b!, "Home.md"), "NOW:\n+ one\n\nNEXT:\n- two\n- three\n");
        } finally {
            await cleanup();
        }
    });

    it("keeps a file modified on one machine and deleted on another", async () => {
        const { machines: { a, b }, cleanup } = await makeWorld(["a", "b"]);
        try {
            await write(a!, "Diode.md", "- x\n");
            await syncOnce(a!);
            await syncOnce(b!);
            await rm(join(a!.dir, "Diode.md"));
            await write(b!, "Diode.md", "- x\n- y\n");
            await syncOnce(a!);
            await syncOnce(b!);
            await syncOnce(a!);
            assert.equal(await read(a!, "Diode.md"), "- x\n- y\n");
        } finally {
            await cleanup();
        }
    });

    it("lets the newer side win for binary files", async () => {
        const { machines: { a, b }, cleanup } = await makeWorld(["a", "b"]);
        try {
            await write(a!, "scan.pdf", Buffer.from([0, 1, 2]));
            await syncOnce(a!);
            await syncOnce(b!);
            await write(a!, "scan.pdf", Buffer.from([0, 1, 2, 3]));
            await syncOnce(a!);
            // Commit timestamps have one-second resolution.
            await new Promise(resolve => setTimeout(resolve, 1100));
            await write(b!, "scan.pdf", Buffer.from([0, 9, 9]));
            await syncOnce(b!);
            await syncOnce(a!);
            assert.deepEqual(await readFile(join(a!.dir, "scan.pdf")), Buffer.from([0, 9, 9]));
            assert.deepEqual(await readFile(join(b!.dir, "scan.pdf")), Buffer.from([0, 9, 9]));
        } finally {
            await cleanup();
        }
    });

    it("joins an existing folder to a remote that already has the same files", async () => {
        const { machines: { a, b }, cleanup } = await makeWorld(["a", "b"]);
        try {
            await write(a!, "Home.md", "- one\n");
            await syncOnce(a!);
            await write(b!, "Home.md", "- one\n- local only\n");
            await write(b!, "Other.md", "text\n");
            await syncOnce(b!);
            await syncOnce(a!);
            assert.equal(await read(a!, "Home.md"), "- one\n- local only\n");
            assert.equal(await read(a!, "Other.md"), "text\n");
        } finally {
            await cleanup();
        }
    });

    it("recovers from a merge interrupted midway", async () => {
        const { machines: { a }, cleanup } = await makeWorld(["a"]);
        try {
            await write(a!, "Home.md", "- one\n");
            await syncOnce(a!);
            const head = await git(a!.dir, ["rev-parse", "HEAD"]);
            await writeFile(join(a!.dir, ".git", "MERGE_HEAD"), `${head}\n`);
            const lock = join(a!.dir, ".git", "index.lock");
            await writeFile(lock, "");
            const old = new Date(Date.now() - 5 * 60_000);
            await utimes(lock, old, old);
            await write(a!, "Home.md", "- one\n- two\n");
            assert.equal((await syncOnce(a!)).pushed, true);
            assert.equal(existsSync(join(a!.dir, ".git", "MERGE_HEAD")), false);
            assert.equal(await read(a!, "Home.md"), "- one\n- two\n");
        } finally {
            await cleanup();
        }
    });

    it("converges without losing lines under random concurrent edits", async () => {
        const hosts = ["a", "b", "c"];
        const { machines, cleanup } = await makeWorld(hosts);
        const files = ["Home.md", "NebiusNow.md", "Diode.md"];
        let seed = 42;
        const random = (n: number) => {
            seed = (seed * 1103515245 + 12345) % 2 ** 31;
            return seed % n;
        };
        const added: string[] = [];
        try {
            for (let round = 0; round < 12; round++) {
                for (const host of hosts) {
                    const target = machines[host]!;
                    const file = files[random(files.length)]!;
                    const path = join(target.dir, file);
                    const lines = existsSync(path) ? (await readFile(path, "utf8")).split("\n").filter(Boolean) : [];
                    // Mark some task done (an edit that can collide) and always add a unique line.
                    if (lines.length > 0) {
                        const i = random(lines.length);
                        lines[i] = lines[i]!.replace(/^- /, "+ ");
                    }
                    const line = `- ${host} round ${round}`;
                    lines.splice(random(lines.length + 1), 0, line);
                    added.push(line.slice(2));
                    await writeFile(path, `${lines.join("\n")}\n`);
                }
                // Machines sync concurrently, so pushes race each other.
                await Promise.all(hosts.map(host => syncOnce(machines[host]!)));
            }
            for (let i = 0; i < 2; i++) for (const host of hosts) await syncOnce(machines[host]!);

            const snapshot = async (t: SyncTarget) => {
                const names = await listFiles(t.dir);
                return Promise.all(names.map(async name => `${name}\n${await read(t, name)}`));
            };
            const reference = await snapshot(machines.a!);
            for (const host of hosts) assert.deepEqual(await snapshot(machines[host]!), reference);
            const everything = reference.join("\n");
            for (const text of added) assert.ok(everything.includes(text), `lost line: ${text}`);
            assert.doesNotMatch(everything, /<<<<<<<|>>>>>>>/);
        } finally {
            await cleanup();
        }
    });
});
