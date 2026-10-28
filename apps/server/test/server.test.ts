import { afterAll, beforeAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { remoteUrl, runDaemon } from "../../../packages/sync/src/daemon.ts";
import { prepareRepo, setRemote } from "../../../packages/sync/src/sync.ts";
import { startServer } from "../src/server.ts";

const TOKEN = "test-token";

async function waitFor(check: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await check()) return;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error("timed out");
}

const fileHas = (path: string, text: string) => async () =>
    existsSync(path) && (await readFile(path, "utf8")).includes(text);

describe("server with sync daemons", () => {
    let root: string;
    let server: Server;
    let url: string;
    const stops: (() => void)[] = [];
    const dirs: Record<string, string> = {};

    beforeAll(async () => {
        root = await mkdtemp(join(tmpdir(), "ttm-server-test-"));
        const started = await startServer(
            { repoPath: join(root, "repos", "notes.git"), token: TOKEN, todoFiles: ["Diode.md", "NebiusNow.md", "Home.md"] },
            0,
        );
        server = started.server;
        url = `http://127.0.0.1:${started.port}`;
        for (const host of ["laptop", "desktop"]) {
            const dir = join(root, host);
            await mkdir(dir);
            await prepareRepo({ dir, host });
            await setRemote(dir, remoteUrl(url));
            dirs[host] = dir;
            stops.push(runDaemon({ dir, host, server: url, token: TOKEN }, () => {}));
        }
    });

    afterAll(async () => {
        stops.forEach(stop => stop());
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        await rm(root, { recursive: true, force: true });
    });

    it("rejects requests without the token", async () => {
        assert.equal((await fetch(`${url}/api/files`)).status, 401);
        assert.equal((await fetch(`${url}/healthz`)).status, 200);
    });

    it("delivers an edit from one machine to another within seconds", async () => {
        await writeFile(join(dirs.laptop!, "Home.md"), "NOW:\n- buy milk\n");
        await waitFor(fileHas(join(dirs.desktop!, "Home.md"), "- buy milk"));
    });

    it("applies an edit made through the API on top of a concurrent push", async () => {
        const auth = { authorization: `Bearer ${TOKEN}` };
        const read = await fetch(`${url}/api/file?path=Home.md`, { headers: auth });
        const base = read.headers.get("x-commit")!;
        const text = await read.text();

        // Meanwhile a machine appends a task.
        await writeFile(join(dirs.desktop!, "Home.md"), `${text}- call mom\n`);
        await waitFor(async () => {
            const current = await fetch(`${url}/api/file?path=Home.md`, { headers: auth });
            return (await current.text()).includes("- call mom");
        });

        // The phone, still on the old version, ticks a task off.
        const put = await fetch(`${url}/api/file?path=Home.md&base=${base}`, {
            method: "PUT",
            headers: auth,
            body: text.replace("- buy milk", "+ buy milk"),
        });
        assert.equal(put.status, 200);
        assert.equal(((await put.json()) as { merged: boolean }).merged, true);

        for (const host of ["laptop", "desktop"]) {
            await waitFor(fileHas(join(dirs[host]!, "Home.md"), "+ buy milk"));
            const content = await readFile(join(dirs[host]!, "Home.md"), "utf8");
            assert.equal(content, "NOW:\n+ buy milk\n- call mom\n");
        }
    });

    it("lists todos from the todo files, parsed", async () => {
        await writeFile(join(dirs.laptop!, "NebiusNow.md"), "NOW:\n- open task\n  + done child\n\nfree text\n");
        await waitFor(async () => {
            const response = await fetch(`${url}/api/file?path=NebiusNow.md`, { headers: { authorization: `Bearer ${TOKEN}` } });
            return response.ok;
        });
        const response = await fetch(`${url}/api/todos`, { headers: { authorization: `Bearer ${TOKEN}` } });
        const body = (await response.json()) as { files: { path: string; nodes: { kind: string; text?: string }[] }[] };
        // Only configured todo files, in configured order; files missing from the repo are skipped.
        assert.deepEqual(body.files.map(f => f.path), ["NebiusNow.md", "Home.md"]);
        assert.deepEqual(body.files[0]!.nodes.map(n => [n.kind, n.text]), [
            ["section", undefined],
            ["task", "open task"],
            ["task", "done child"],
            ["text", "free text"],
        ]);
    });

    it("answers CORS preflight without a token and marks responses for any origin", async () => {
        const preflight = await fetch(`${url}/api/todos`, { method: "OPTIONS" });
        assert.equal(preflight.status, 204);
        assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
        assert.match(preflight.headers.get("access-control-allow-headers") ?? "", /authorization/);
        const file = await fetch(`${url}/api/file?path=Home.md`, { headers: { authorization: `Bearer ${TOKEN}` } });
        assert.equal(file.headers.get("access-control-expose-headers"), "x-commit");
    });

    it("refuses paths outside the repo", async () => {
        const response = await fetch(`${url}/api/file?path=../../etc/passwd`, {
            headers: { authorization: `Bearer ${TOKEN}` },
        });
        assert.equal(response.status, 400);
    });
});
