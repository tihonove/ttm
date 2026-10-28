import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { followServerEvents, isNetworkError } from "../src/daemon.ts";

describe("isNetworkError", () => {
    it("recognizes being offline or a restarting server", () => {
        for (const message of [
            "fatal: unable to access 'https://ttm.tihonove.dev/git/notes.git/': Could not resolve host: ttm.tihonove.dev",
            "fatal: unable to access 'https://x/': Failed to connect to x port 443 after 3 ms: Couldn't connect to server",
            "fatal: unable to access 'https://x/': Connection timed out after 30001 milliseconds",
            "fatal: unable to access 'https://x/': The requested URL returned error: 502",
            "error: RPC failed; curl 56 Recv failure: Connection reset by peer",
        ]) {
            assert.equal(isNetworkError(new Error(message)), true, message);
        }
    });

    it("treats auth and repository problems as real failures", () => {
        for (const message of [
            "fatal: unable to access 'https://x/': The requested URL returned error: 401",
            "fatal: unable to access 'https://x/': The requested URL returned error: 404",
            "a rebase is in progress in the notes repo; finish or abort it by hand",
        ]) {
            assert.equal(isNetworkError(new Error(message)), false, message);
        }
    });
});

describe("followServerEvents", () => {
    it("reconnects when a request hangs before any response", async () => {
        let requests = 0;
        const server = createServer((_req, res) => {
            // The first request is accepted and never answered, like an ingress during a redeploy.
            if (++requests === 1) return;
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.write(`event: head\ndata: {"head":"abc"}\n\n`);
        });
        await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
        const { port } = server.address() as AddressInfo;
        const stop = new AbortController();
        try {
            const head = await new Promise<string | null>(resolve => {
                const config = { dir: "", host: "", server: `http://127.0.0.1:${port}`, token: "t" };
                void followServerEvents(config, resolve, stop.signal, () => {}, 200);
            });
            assert.equal(head, "abc");
            assert.equal(requests, 2);
        } finally {
            stop.abort();
            server.closeAllConnections();
            server.close();
        }
    });
});
