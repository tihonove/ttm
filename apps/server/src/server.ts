import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { dirname, join, posix } from "node:path";
import { serveGitHttp } from "./git-http.ts";
import { parse, type TodoNode } from "@ttm/parser/parse";
import { NotesRepo } from "./repo.ts";
import { appPage, APK_NAME } from "./app-page.ts";
import { findAsset, loadUpdate, manifestResponse } from "./updates.ts";

export interface ServerOptions {
    /** Path of the bare notes repository; its parent is served over git HTTP. */
    repoPath: string;
    token: string;
    /** Notes files the todo list is built from, repo-relative. */
    todoFiles?: string[];
    /** `expo export` of the app plus update.json, baked into the image. */
    updatesDir?: string;
    /** PEM key that signs update manifests; the app holds the matching certificate. */
    updatesPrivateKey?: string;
    /** Directory with the current ttm.apk for download. */
    appDir?: string;
    log?: (message: string) => void;
}

export const DEFAULT_TODO_FILES = ["Diode.md", "NebiusNow.md", "Home.md"];

/** Any origin may call the API: auth is a bearer token, never a cookie. */
const CORS_HEADERS = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, PUT, OPTIONS",
    "access-control-expose-headers": "x-commit",
};

const REPO_NAME = "notes.git";
const HEARTBEAT_MS = 20_000;
const MAX_BODY = 16 * 1024 * 1024;

/** Fans out "the branch moved" to every connected daemon and app. */
class HeadEvents {
    private readonly clients = new Set<ServerResponse>();
    private last: string | undefined;
    private readonly repo: NotesRepo;

    constructor(repo: NotesRepo) {
        this.repo = repo;
    }

    async subscribe(res: ServerResponse): Promise<void> {
        res.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            "x-accel-buffering": "no",
        });
        // Over HTTP/2 the ingress held the whole stream back; headers now and a padding comment
        // push the first bytes through any buffer in between.
        res.flushHeaders();
        res.write(`:${" ".repeat(2048)}\n\n`);
        this.clients.add(res);
        res.on("close", () => this.clients.delete(res));
        this.last = await this.repo.head();
        this.send(res, this.last);
    }

    async refresh(): Promise<void> {
        const head = await this.repo.head();
        if (head === this.last) return;
        this.last = head;
        for (const client of this.clients) this.send(client, head);
    }

    heartbeat(): void {
        for (const client of this.clients) client.write(": ping\n\n");
    }

    close(): void {
        for (const client of this.clients) client.end();
    }

    private send(res: ServerResponse, head: string | undefined): void {
        res.write(`event: head\ndata: ${JSON.stringify({ head: head ?? null })}\n\n`);
    }
}

function tokenMatches(given: string, expected: string): boolean {
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
}

/** Accepts `Bearer <token>` or HTTP Basic with the token as password (what git sends). */
function isAuthorized(req: IncomingMessage, token: string): boolean {
    const header = req.headers.authorization ?? "";
    const [scheme, value = ""] = header.split(" ", 2);
    if (scheme?.toLowerCase() === "bearer") return tokenMatches(value, token);
    if (scheme?.toLowerCase() === "basic") {
        const decoded = Buffer.from(value, "base64").toString("utf8");
        return tokenMatches(decoded.slice(decoded.indexOf(":") + 1), token);
    }
    return false;
}

/** Repo-relative path from user input, or undefined if it tries to escape or touch .git. */
function safePath(raw: string | null): string | undefined {
    if (!raw) return undefined;
    const normalized = posix.normalize(raw).replace(/^\/+/, "");
    if (!normalized || normalized.startsWith("..") || normalized.split("/").includes(".git")) return undefined;
    return normalized;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > MAX_BODY) throw new Error("body too large");
        chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
}

function header(req: IncomingMessage, name: string): string | undefined {
    const value = req.headers[name];
    return Array.isArray(value) ? value[0] : value;
}

/** Origin as the client sees it: TLS ends at the ingress, which says so in x-forwarded-proto. */
function publicOrigin(req: IncomingMessage): string {
    const proto = header(req, "x-forwarded-proto")?.split(",")[0]?.trim() ?? "http";
    return `${proto}://${header(req, "host") ?? "localhost"}`;
}

function json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

export async function startServer(options: ServerOptions, port: number): Promise<{ server: Server; port: number }> {
    const log = options.log ?? (() => {});
    const repo = new NotesRepo(options.repoPath);
    await repo.init();
    const events = new HeadEvents(repo);
    // The update and the APK ship inside the image and never change while the server runs.
    const update = options.updatesDir ? await loadUpdate(options.updatesDir) : undefined;
    const apkPath = options.appDir ? join(options.appDir, APK_NAME) : undefined;
    const apk = apkPath && existsSync(apkPath) ? { path: apkPath, size: statSync(apkPath).size } : undefined;
    const heartbeat = setInterval(() => events.heartbeat(), HEARTBEAT_MS);

    const server = createServer(async (req, res) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        for (const [name, value] of Object.entries(CORS_HEADERS)) res.setHeader(name, value);
        try {
            if (req.method === "OPTIONS") return void res.writeHead(204).end();
            if (url.pathname === "/healthz") return void res.writeHead(200).end("ok\n");

            // Public: the app's code is public anyway, and updates are verified by their signature.
            if (url.pathname === "/updates/manifest" && req.method === "GET") {
                const response = manifestResponse(
                    update,
                    {
                        platform: header(req, "expo-platform"),
                        runtimeVersion: header(req, "expo-runtime-version"),
                        expectsSignature: header(req, "expo-expect-signature") !== undefined,
                        baseUrl: publicOrigin(req),
                    },
                    options.updatesPrivateKey,
                );
                return void res.writeHead(response.status, response.headers).end(response.body);
            }
            if (url.pathname.startsWith("/updates/assets/") && req.method === "GET") {
                const asset = findAsset(update, decodeURIComponent(url.pathname.slice("/updates/assets/".length)));
                if (!asset || !options.updatesDir) return json(res, 404, { error: "not found" });
                res.writeHead(200, { "content-type": asset.contentType, "cache-control": "public, max-age=31536000, immutable" });
                return void createReadStream(join(options.updatesDir, asset.path)).pipe(res);
            }
            if (url.pathname === "/app" && req.method === "GET") {
                res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
                return void res.end(appPage({ apkSize: apk?.size, update }));
            }
            if (url.pathname === `/app/${APK_NAME}` && req.method === "GET") {
                if (!apk) return json(res, 404, { error: "no APK in this build" });
                res.writeHead(200, {
                    "content-type": "application/vnd.android.package-archive",
                    "content-length": String(apk.size),
                    "content-disposition": `attachment; filename="${APK_NAME}"`,
                    "cache-control": "no-cache",
                });
                return void createReadStream(apk.path).pipe(res);
            }

            if (!isAuthorized(req, options.token)) {
                return void res.writeHead(401, { "www-authenticate": 'Basic realm="ttm"' }).end();
            }

            if (url.pathname.startsWith(`/git/${REPO_NAME}/`)) {
                await serveGitHttp(req, res, {
                    projectRoot: dirname(options.repoPath),
                    pathInfo: url.pathname.slice("/git".length),
                    query: url.search.slice(1),
                    user: "ttm",
                });
                if (url.pathname.endsWith("/git-receive-pack")) await events.refresh();
                return;
            }

            if (url.pathname === "/events" && req.method === "GET") return void (await events.subscribe(res));

            if (url.pathname === "/api/files" && req.method === "GET") {
                const head = await repo.head();
                return json(res, 200, { head: head ?? null, files: await repo.listFiles(head) });
            }

            if (url.pathname === "/api/todos" && req.method === "GET") {
                const head = await repo.head();
                const files = [];
                for (const path of options.todoFiles ?? DEFAULT_TODO_FILES) {
                    const content = await repo.readFile(path, head);
                    if (!content) continue;
                    const nodes: TodoNode[] = parse(content.toString("utf8")).nodes.filter(n => n.kind !== "blank");
                    files.push({ path, nodes });
                }
                return json(res, 200, { head: head ?? null, files });
            }

            if (url.pathname === "/api/file") {
                const path = safePath(url.searchParams.get("path"));
                if (!path) return json(res, 400, { error: "bad path" });
                if (req.method === "GET") {
                    const head = await repo.head();
                    const content = await repo.readFile(path, head);
                    if (!content) return json(res, 404, { error: "not found" });
                    return void res.writeHead(200, { "content-type": "application/octet-stream", "x-commit": head }).end(content);
                }
                if (req.method === "PUT") {
                    const result = await repo.writeFile({
                        path,
                        content: await readBody(req),
                        baseCommit: url.searchParams.get("base") ?? undefined,
                        message: url.searchParams.get("message") ?? `edit(server): ${path}`,
                    });
                    await events.refresh();
                    return json(res, 200, result);
                }
            }

            json(res, 404, { error: "not found" });
        } catch (error) {
            log(`${req.method} ${url.pathname}: ${error}`);
            if (!res.headersSent) json(res, 500, { error: "internal error" });
            else res.end();
        }
    });
    server.on("close", () => {
        clearInterval(heartbeat);
        events.close();
    });
    await new Promise<void>(resolve => server.listen(port, resolve));
    const address = server.address();
    return { server, port: typeof address === "object" && address ? address.port : port };
}
