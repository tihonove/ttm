// Expo Updates protocol v1 for the mobile app (docs.expo.dev/technical-specs/expo-updates-1).
// The update is an `expo export` baked into the server image at build time, so shipping new app
// JS is a server deploy and the server keeps no state for it.
import { createHash, createSign, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Written next to the export by CI: what the export alone does not say. */
export interface UpdateInfo {
    runtimeVersion: string;
    createdAt: string;
    /** Public app config (`expo config --type public`), exposed to the app as Constants.expoConfig. */
    expoClient?: Record<string, unknown>;
}

interface ExportMetadata {
    fileMetadata: Record<string, { bundle: string; assets: { path: string; ext: string }[] }>;
}

export interface UpdateAsset {
    path: string;
    hash: string;
    key: string;
    contentType: string;
    fileExtension?: string;
}

export interface Update {
    id: string;
    runtimeVersion: string;
    createdAt: string;
    platform: string;
    launchAsset: UpdateAsset;
    assets: UpdateAsset[];
    expoClient?: Record<string, unknown>;
}

const PLATFORM = "android";

const CONTENT_TYPES: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    ttf: "font/ttf",
    otf: "font/otf",
    woff: "font/woff",
    woff2: "font/woff2",
    json: "application/json",
};

async function describeAsset(dir: string, path: string, contentType: string, ext?: string): Promise<UpdateAsset> {
    const content = await readFile(join(dir, path));
    return {
        path,
        hash: createHash("sha256").update(content).digest("base64url"),
        key: createHash("md5").update(content).digest("hex"),
        contentType,
        ...(ext ? { fileExtension: `.${ext}` } : {}),
    };
}

/** UUID-shaped id derived from content, so the same update always has the same id. */
function contentId(...parts: string[]): string {
    const hex = createHash("sha256").update(parts.join("\n")).digest("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** Reads the baked-in export; undefined when the image carries none (local builds). */
export async function loadUpdate(dir: string): Promise<Update | undefined> {
    if (!existsSync(join(dir, "metadata.json")) || !existsSync(join(dir, "update.json"))) return undefined;
    const metadata = JSON.parse(await readFile(join(dir, "metadata.json"), "utf8")) as ExportMetadata;
    const info = JSON.parse(await readFile(join(dir, "update.json"), "utf8")) as UpdateInfo;
    const files = metadata.fileMetadata[PLATFORM];
    if (!files) return undefined;
    const launchAsset = await describeAsset(dir, files.bundle, "application/javascript");
    const assets = await Promise.all(
        files.assets.map(a => describeAsset(dir, a.path, CONTENT_TYPES[a.ext] ?? "application/octet-stream", a.ext)),
    );
    return {
        id: contentId(launchAsset.hash, ...assets.map(a => a.hash), info.runtimeVersion, info.createdAt),
        runtimeVersion: info.runtimeVersion,
        createdAt: info.createdAt,
        platform: PLATFORM,
        launchAsset,
        assets,
        ...(info.expoClient ? { expoClient: info.expoClient } : {}),
    };
}

export interface ManifestRequest {
    platform: string | undefined;
    runtimeVersion: string | undefined;
    expectsSignature: boolean;
    /** Origin the client reached us at; asset URLs are built on it. */
    baseUrl: string;
}

export interface UpdatesResponse {
    status: number;
    headers: Record<string, string>;
    body: string;
}

const COMMON_HEADERS = {
    "expo-protocol-version": "1",
    "expo-sfv-version": "0",
    "cache-control": "private, max-age=0",
};

function assetEntry(asset: UpdateAsset, baseUrl: string) {
    return {
        hash: asset.hash,
        key: asset.key,
        contentType: asset.contentType,
        ...(asset.fileExtension ? { fileExtension: asset.fileExtension } : {}),
        url: `${baseUrl}/updates/assets/${asset.path}`,
    };
}

function part(name: string, body: string, extraHeaders: Record<string, string> = {}): string {
    const headers = {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `form-data; name="${name}"`,
        ...extraHeaders,
    };
    return `${Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n${body}\r\n`;
}

/** RSA-SHA256 over the exact manifest bytes, as an Expo SFV dictionary. */
export function signatureHeader(body: string, privateKey: string): string {
    const sig = createSign("RSA-SHA256").update(body, "utf8").sign(privateKey, "base64");
    return `sig="${sig}", keyid="main"`;
}

export function manifestResponse(
    update: Update | undefined,
    request: ManifestRequest,
    privateKey: string | undefined,
): UpdatesResponse {
    if (request.platform !== PLATFORM) {
        return { status: 400, headers: { "content-type": "text/plain" }, body: `unsupported platform: ${request.platform}\n` };
    }
    // Nothing for this native build: an older APK must not get JS written for newer native code.
    if (!update || request.runtimeVersion !== update.runtimeVersion) {
        return { status: 204, headers: { ...COMMON_HEADERS }, body: "" };
    }
    if (request.expectsSignature && !privateKey) {
        return { status: 500, headers: { "content-type": "text/plain" }, body: "update signing key is not configured\n" };
    }
    const manifest = JSON.stringify({
        id: update.id,
        createdAt: update.createdAt,
        runtimeVersion: update.runtimeVersion,
        launchAsset: assetEntry({ ...update.launchAsset, fileExtension: undefined }, request.baseUrl),
        assets: update.assets.map(a => assetEntry(a, request.baseUrl)),
        metadata: {},
        extra: update.expoClient ? { expoClient: update.expoClient } : {},
    });
    const boundary = `ttm-${randomBytes(12).toString("hex")}`;
    const signature: Record<string, string> = request.expectsSignature
        ? { "expo-signature": signatureHeader(manifest, privateKey!) }
        : {};
    const body =
        `--${boundary}\r\n${part("manifest", manifest, signature)}` +
        `--${boundary}\r\n${part("extensions", JSON.stringify({ assetRequestHeaders: {} }))}` +
        `--${boundary}--\r\n`;
    return {
        status: 200,
        headers: { ...COMMON_HEADERS, "content-type": `multipart/mixed; boundary=${boundary}` },
        body,
    };
}

/** The asset of the current update at `path`, or undefined: only files the manifest lists are served. */
export function findAsset(update: Update | undefined, path: string): UpdateAsset | undefined {
    if (!update) return undefined;
    return [update.launchAsset, ...update.assets].find(asset => asset.path === path);
}
