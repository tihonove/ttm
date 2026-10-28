import { afterAll, beforeAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import { createHash, createVerify, generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server.ts";
import { findAsset, loadUpdate, manifestResponse, type ManifestRequest, type Update } from "../src/updates.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
});

const BUNDLE = "_expo/static/js/android/index-abc.hbc";
const ICON = "assets/0123abcd";

async function makeExport(dir: string, runtimeVersion = "1"): Promise<void> {
    await mkdir(join(dir, "_expo/static/js/android"), { recursive: true });
    await mkdir(join(dir, "assets"), { recursive: true });
    await writeFile(join(dir, BUNDLE), "bundle bytes");
    await writeFile(join(dir, ICON), "png bytes");
    await writeFile(
        join(dir, "metadata.json"),
        JSON.stringify({ version: 0, bundler: "metro", fileMetadata: { android: { bundle: BUNDLE, assets: [{ path: ICON, ext: "png" }] } } }),
    );
    await writeFile(
        join(dir, "update.json"),
        JSON.stringify({ runtimeVersion, createdAt: "2026-10-29T00:00:00.000Z", expoClient: { name: "ttm" } }),
    );
}

/** Splits a multipart/mixed body into named parts with their headers. */
function parseMultipart(body: string, contentType: string) {
    const boundary = /boundary=(.+)$/.exec(contentType)![1]!;
    return body
        .split(`--${boundary}`)
        .slice(1, -1)
        .map(chunk => {
            const [head, ...rest] = chunk.replace(/^\r\n/, "").split("\r\n\r\n");
            const headers = Object.fromEntries(head!.split("\r\n").map(line => line.split(/: (.*)/s).slice(0, 2) as [string, string]));
            return { headers, body: rest.join("\r\n\r\n").replace(/\r\n$/, "") };
        });
}

const request = (overrides: Partial<ManifestRequest> = {}): ManifestRequest => ({
    platform: "android",
    runtimeVersion: "1",
    expectsSignature: true,
    baseUrl: "https://ttm.example",
    ...overrides,
});

describe("updates", () => {
    let dir: string;
    let update: Update;

    beforeAll(async () => {
        dir = await mkdtemp(join(tmpdir(), "ttm-updates-test-"));
        await makeExport(dir);
        update = (await loadUpdate(dir))!;
    });
    afterAll(() => rm(dir, { recursive: true, force: true }));

    it("describes the export with hashes the app verifies", () => {
        const sha = (text: string) => createHash("sha256").update(text).digest("base64url");
        assert.equal(update.launchAsset.hash, sha("bundle bytes"));
        assert.equal(update.launchAsset.key, createHash("md5").update("bundle bytes").digest("hex"));
        assert.deepEqual(update.assets.map(a => [a.path, a.hash, a.contentType, a.fileExtension]), [
            [ICON, sha("png bytes"), "image/png", ".png"],
        ]);
        assert.match(update.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it("gives the same export the same id and a changed bundle a new one", async () => {
        assert.equal((await loadUpdate(dir))!.id, update.id);
        const other = await mkdtemp(join(tmpdir(), "ttm-updates-test-"));
        await makeExport(other);
        await writeFile(join(other, BUNDLE), "new bundle bytes");
        assert.notEqual((await loadUpdate(other))!.id, update.id);
        await rm(other, { recursive: true, force: true });
    });

    it("has no update where the image carries no export", async () => {
        assert.equal(await loadUpdate(join(dir, "missing")), undefined);
    });

    it("answers with a signed multipart manifest", () => {
        const response = manifestResponse(update, request(), privateKey);
        assert.equal(response.status, 200);
        assert.equal(response.headers["expo-protocol-version"], "1");
        assert.equal(response.headers["expo-sfv-version"], "0");
        const parts = parseMultipart(response.body, response.headers["content-type"]!);
        const manifestPart = parts.find(p => p.headers["content-disposition"] === 'form-data; name="manifest"')!;
        const signature = /^sig="([^"]+)", keyid="main"$/.exec(manifestPart.headers["expo-signature"]!)![1]!;
        assert.equal(createVerify("RSA-SHA256").update(manifestPart.body).verify(publicKey, signature, "base64"), true);

        const manifest = JSON.parse(manifestPart.body);
        assert.equal(manifest.id, update.id);
        assert.equal(manifest.runtimeVersion, "1");
        assert.equal(manifest.launchAsset.url, `https://ttm.example/updates/assets/${BUNDLE}`);
        assert.equal(manifest.launchAsset.fileExtension, undefined);
        assert.equal(manifest.assets[0].fileExtension, ".png");
        assert.deepEqual(manifest.extra, { expoClient: { name: "ttm" } });
        const extensions = parts.find(p => p.headers["content-disposition"] === 'form-data; name="extensions"')!;
        assert.deepEqual(JSON.parse(extensions.body), { assetRequestHeaders: {} });
    });

    it("leaves the manifest unsigned when the app does not ask for a signature", () => {
        const response = manifestResponse(update, request({ expectsSignature: false }), undefined);
        const parts = parseMultipart(response.body, response.headers["content-type"]!);
        assert.equal(parts[0]!.headers["expo-signature"], undefined);
    });

    it("offers nothing to a build with another runtime version, or when there is no update", () => {
        for (const response of [manifestResponse(update, request({ runtimeVersion: "0" }), privateKey), manifestResponse(undefined, request(), privateKey)]) {
            assert.equal(response.status, 204);
            assert.equal(response.body, "");
            assert.equal(response.headers["expo-protocol-version"], "1");
        }
    });

    it("refuses other platforms and a requested signature it cannot make", () => {
        assert.equal(manifestResponse(update, request({ platform: "ios" }), privateKey).status, 400);
        assert.equal(manifestResponse(update, request(), undefined).status, 500);
    });

    it("finds only assets the manifest lists", () => {
        assert.equal(findAsset(update, BUNDLE)?.path, BUNDLE);
        assert.equal(findAsset(update, "metadata.json"), undefined);
        assert.equal(findAsset(undefined, BUNDLE), undefined);
    });
});

describe("server: updates and the APK page", () => {
    let root: string;
    let server: Server;
    let url: string;

    beforeAll(async () => {
        root = await mkdtemp(join(tmpdir(), "ttm-updates-server-"));
        await makeExport(join(root, "updates"));
        await mkdir(join(root, "app"));
        await writeFile(join(root, "app", "ttm.apk"), "apk bytes");
        const started = await startServer(
            {
                repoPath: join(root, "repos", "notes.git"),
                token: "secret",
                updatesDir: join(root, "updates"),
                updatesPrivateKey: privateKey,
                appDir: join(root, "app"),
            },
            0,
        );
        server = started.server;
        url = `http://127.0.0.1:${started.port}`;
    });
    afterAll(async () => {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        await rm(root, { recursive: true, force: true });
    });

    it("serves the manifest without the token, with asset URLs on the forwarded origin", async () => {
        const response = await fetch(`${url}/updates/manifest`, {
            headers: {
                "expo-platform": "android",
                "expo-runtime-version": "1",
                "expo-protocol-version": "1",
                "expo-expect-signature": 'sig, keyid="main", alg="rsa-v1_5-sha256"',
                "x-forwarded-proto": "https",
                accept: "multipart/mixed",
            },
        });
        assert.equal(response.status, 200);
        const parts = parseMultipart(await response.text(), response.headers.get("content-type")!);
        const manifest = JSON.parse(parts[0]!.body);
        assert.match(manifest.launchAsset.url, /^https:\/\/127\.0\.0\.1:\d+\/updates\/assets\//);
        assert.ok(parts[0]!.headers["expo-signature"]);
    });

    it("serves listed assets as immutable files, nothing else", async () => {
        const asset = await fetch(`${url}/updates/assets/${BUNDLE}`);
        assert.equal(asset.status, 200);
        assert.equal(asset.headers.get("content-type"), "application/javascript");
        assert.match(asset.headers.get("cache-control") ?? "", /immutable/);
        assert.equal(await asset.text(), "bundle bytes");
        assert.equal((await fetch(`${url}/updates/assets/metadata.json`)).status, 404);
        assert.equal((await fetch(`${url}/updates/assets/..%2Fapp%2Fttm.apk`)).status, 404);
    });

    it("shows the install page and serves the APK without the token", async () => {
        const page = await fetch(`${url}/app`);
        assert.equal(page.status, 200);
        assert.match(await page.text(), /href="\/app\/ttm\.apk"/);
        const apk = await fetch(`${url}/app/ttm.apk`);
        assert.equal(apk.headers.get("content-type"), "application/vnd.android.package-archive");
        assert.match(apk.headers.get("content-disposition") ?? "", /ttm\.apk/);
        assert.equal(await apk.text(), "apk bytes");
    });

    it("keeps the notes API behind the token", async () => {
        assert.equal((await fetch(`${url}/api/todos`)).status, 401);
    });
});

describe("server without a baked-in app", () => {
    it("says there is no APK and offers no update", async () => {
        const root = await mkdtemp(join(tmpdir(), "ttm-updates-empty-"));
        const { server, port } = await startServer({ repoPath: join(root, "notes.git"), token: "t", appDir: join(root, "none") }, 0);
        try {
            const page = await (await fetch(`http://127.0.0.1:${port}/app`)).text();
            assert.match(page, /APK нет/);
            assert.equal((await fetch(`http://127.0.0.1:${port}/app/ttm.apk`)).status, 404);
            const manifest = await fetch(`http://127.0.0.1:${port}/updates/manifest`, {
                headers: { "expo-platform": "android", "expo-runtime-version": "1" },
            });
            assert.equal(manifest.status, 204);
        } finally {
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
            await rm(root, { recursive: true, force: true });
        }
    });
});
