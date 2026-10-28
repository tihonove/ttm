import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { isNetworkError } from "../src/daemon.ts";

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
