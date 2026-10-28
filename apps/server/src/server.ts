import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { dirname, posix } from "node:path";
import { serveGitHttp } from "./git-http.ts";
import { parse, type TodoNode } from "@ttm/parser/parse";
import { NotesRepo } from "./repo.ts";

export interface ServerOptions {
    /** Path of the bare notes repository; its parent is served over git HTTP. */
    repoPath: string;
    token: string;
    /** Notes files the todo list is built from, repo-relative. */
    todoFiles?: string[];
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

function json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

export async function startServer(options: ServerOptions, port: number): Promise<{ server: Server; port: number }> {
    const log = options.log ?? (() => {});
    const repo = new NotesRepo(options.repoPath);
    await repo.init();
    const events = new HeadEvents(repo);
    const heartbeat = setInterval(() => events.heartbeat(), HEARTBEAT_MS);

    const server = createServer(async (req, res) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        for (const [name, value] of Object.entries(CORS_HEADERS)) res.setHeader(name, value);
        try {
            if (req.method === "OPTIONS") return void res.writeHead(204).end();
            if (url.pathname === "/healthz") return void res.writeHead(200).end("ok\n");
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
