import { spawn } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";

export interface GitHttpOptions {
    /** Directory containing the bare repositories (GIT_PROJECT_ROOT). */
    projectRoot: string;
    /** Path below projectRoot, e.g. `/notes.git/info/refs`. */
    pathInfo: string;
    query: string;
    user: string;
}

const HEADER_END = Buffer.from("\r\n\r\n");

/**
 * Serves git smart HTTP by running `git http-backend` as a CGI program. Resolves once the
 * response is complete, so callers can react to a finished push.
 */
export function serveGitHttp(req: IncomingMessage, res: ServerResponse, options: GitHttpOptions): Promise<void> {
    return new Promise(resolve => {
        const env: NodeJS.ProcessEnv = {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            GIT_PROJECT_ROOT: options.projectRoot,
            GIT_HTTP_EXPORT_ALL: "1",
            GIT_HTTP_MAX_REQUEST_BUFFER: "100M",
            PATH_INFO: options.pathInfo,
            QUERY_STRING: options.query,
            REQUEST_METHOD: req.method ?? "GET",
            CONTENT_TYPE: req.headers["content-type"] ?? "",
            REMOTE_USER: options.user,
            REMOTE_ADDR: req.socket.remoteAddress ?? "",
        };
        if (req.headers["content-length"]) env.CONTENT_LENGTH = req.headers["content-length"];
        if (req.headers["content-encoding"]) env.HTTP_CONTENT_ENCODING = req.headers["content-encoding"];
        const protocol = req.headers["git-protocol"];
        if (typeof protocol === "string") env.GIT_PROTOCOL = protocol;

        const child = spawn("git", ["http-backend"], { env, stdio: ["pipe", "pipe", "pipe"] });
        req.pipe(child.stdin);
        child.stdin.on("error", () => {});
        child.stderr.on("data", (chunk: Buffer) => process.stderr.write(`git http-backend: ${chunk}`));

        let head = Buffer.alloc(0);
        let headersSent = false;
        child.stdout.on("data", (chunk: Buffer) => {
            if (headersSent) {
                res.write(chunk);
                return;
            }
            head = Buffer.concat([head, chunk]);
            const end = head.indexOf(HEADER_END);
            if (end < 0) return;
            let status = 200;
            for (const line of head.subarray(0, end).toString("latin1").split("\r\n")) {
                const colon = line.indexOf(":");
                if (colon < 0) continue;
                const name = line.slice(0, colon).trim();
                const value = line.slice(colon + 1).trim();
                if (name.toLowerCase() === "status") status = Number.parseInt(value, 10) || 500;
                else res.setHeader(name, value);
            }
            res.writeHead(status);
            headersSent = true;
            const body = head.subarray(end + HEADER_END.length);
            if (body.length) res.write(body);
        });
        child.on("close", () => {
            if (!headersSent) res.writeHead(500).end("git http-backend failed\n");
            else res.end();
            resolve();
        });
        child.on("error", () => {
            if (!res.headersSent) res.writeHead(500);
            res.end();
            resolve();
        });
    });
}
