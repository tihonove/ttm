import { spawn } from "node:child_process";
import { watch } from "node:fs";
import http, { type IncomingMessage } from "node:http";
import https from "node:https";
import { basename } from "node:path";
import { configEnv, resolveRef } from "@ttm/git/git";
import { syncOnce, type SyncTarget } from "./sync.ts";

export interface DaemonConfig {
    dir: string;
    host: string;
    /** Base URL of the ttm server, e.g. https://ttm.tihonove.dev */
    server: string;
    token: string;
}

/** Quiet period after the last local edit before committing. */
const DEBOUNCE_MS = 2_000;
/** Upper bound on waiting while edits keep coming. */
const MAX_DELAY_MS = 15_000;
/** Safety net in case an event from the server got lost. */
const PERIODIC_MS = 5 * 60_000;
const MAX_BACKOFF_MS = 5 * 60_000;
/** The server pings every 20s; silence this long means the stream is dead. */
const EVENTS_STALE_MS = 60_000;
const NOTIFY_AFTER_FAILURES = 3;

/**
 * Being offline (or the server restarting) is normal for a laptop and heals by itself, so it is
 * only logged. Anything else — auth, a broken repo — needs a human and is notified.
 */
const NETWORK_ERROR =
    /could not resolve host|failed to connect|couldn't connect|connection (refused|reset)|timed out|network is unreachable|no route to host|empty reply|recv failure|returned error: 5\d\d/i;

export function isNetworkError(error: unknown): boolean {
    return NETWORK_ERROR.test(String(error));
}

const TEMP_FILE = /(^\.#|~$|\.swp$|\.swx$|\.tmp$|^\.~lock\.)/;

export function authEnv(token: string): NodeJS.ProcessEnv {
    const basic = Buffer.from(`ttm:${token}`).toString("base64");
    return configEnv({ "http.extraHeader": `Authorization: Basic ${basic}` });
}

export function remoteUrl(server: string): string {
    return `${server.replace(/\/+$/, "")}/git/notes.git`;
}

function notify(summary: string, body: string): void {
    const child = spawn("notify-send", ["--app-name=ttm-sync", summary, body], { stdio: "ignore" });
    child.on("error", () => {});
}

/** Runs one sync at a time; requests that arrive meanwhile collapse into a single follow-up. */
class SyncScheduler {
    private running = false;
    private current: Promise<void> | undefined;
    private rerun = false;
    private timer: NodeJS.Timeout | undefined;
    private firstRequestAt: number | undefined;
    private failures = 0;
    /** Failures that are not network trouble; past NOTIFY_AFTER_FAILURES the user is told. */
    private seriousFailures = 0;
    private stopped = false;
    private readonly target: SyncTarget;
    private readonly log: (message: string) => void;

    constructor(target: SyncTarget, log: (message: string) => void) {
        this.target = target;
        this.log = log;
    }

    /** Local edit: wait for a quiet period, but never longer than MAX_DELAY_MS overall. */
    debounced(): void {
        const now = Date.now();
        this.firstRequestAt ??= now;
        const delay = Math.min(DEBOUNCE_MS, Math.max(0, this.firstRequestAt + MAX_DELAY_MS - now));
        this.schedule(delay);
    }

    now(): void {
        this.schedule(0);
    }

    /** Stops scheduling and resolves once a sync in progress has finished. */
    async stop(): Promise<void> {
        this.stopped = true;
        clearTimeout(this.timer);
        await this.current;
    }

    private schedule(delay: number): void {
        if (this.stopped) return;
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.run(), delay);
    }

    private run(): void {
        this.timer = undefined;
        this.firstRequestAt = undefined;
        if (this.running) {
            this.rerun = true;
            return;
        }
        this.current = this.execute();
    }

    private async execute(): Promise<void> {
        this.running = true;
        try {
            const result = await syncOnce(this.target);
            if (result.committed || result.merged || result.pushed) {
                this.log(`synced: committed=${result.committed} merged=${result.merged} pushed=${result.pushed}`);
            }
            if (result.conflictCopies.length > 0) {
                notify("Notes: conflict copies created", result.conflictCopies.join("\n"));
            }
            if (this.seriousFailures >= NOTIFY_AFTER_FAILURES) notify("Notes sync restored", "");
            this.failures = 0;
            this.seriousFailures = 0;
        } catch (error) {
            this.failures++;
            const backoff = Math.min(MAX_BACKOFF_MS, 5_000 * 2 ** (this.failures - 1));
            this.log(`sync failed (${this.failures} in a row, retry in ${backoff / 1000}s): ${error}`);
            if (!isNetworkError(error) && ++this.seriousFailures === NOTIFY_AFTER_FAILURES) {
                notify("Notes sync is failing", String(error));
            }
            this.schedule(backoff);
        } finally {
            this.running = false;
        }
        if (this.rerun) {
            this.rerun = false;
            this.now();
        }
    }
}

/**
 * Opens the server's event stream on a fresh HTTP/1.1 connection. Not fetch: over HTTP/2 the
 * ingress held the stream back, and after a failed request fetch reused a stuck pooled connection.
 */
function openEvents(config: DaemonConfig, signal: AbortSignal): Promise<IncomingMessage> {
    const url = new URL(`${config.server.replace(/\/+$/, "")}/events`);
    const client = url.protocol === "https:" ? https : http;
    return new Promise((resolve, reject) => {
        const request = client.get(url, {
            headers: { authorization: `Bearer ${config.token}`, accept: "text/event-stream" },
            agent: false,
            signal,
        });
        request.on("response", response => {
            if (response.statusCode === 200) return resolve(response);
            response.resume();
            reject(new Error(`events: HTTP ${response.statusCode}`));
        });
        request.on("error", reject);
    });
}

/** Listens to the server's head events and asks for a sync when the branch moves elsewhere. */
export async function followServerEvents(
    config: DaemonConfig,
    onHead: (head: string | null) => void,
    signal: AbortSignal,
    log: (message: string) => void,
    staleMs = EVENTS_STALE_MS,
): Promise<void> {
    let backoff = Math.min(1_000, staleMs);
    while (!signal.aborted) {
        const connection = new AbortController();
        const abort = () => connection.abort();
        signal.addEventListener("abort", abort);
        let stale: NodeJS.Timeout | undefined;
        // Armed before the request too: a connection can hang before any response arrives.
        const alive = () => {
            clearTimeout(stale);
            stale = setTimeout(abort, staleMs);
        };
        alive();
        try {
            const response = await openEvents(config, connection.signal);
            backoff = Math.min(1_000, staleMs);
            response.setEncoding("utf8");
            let buffer = "";
            for await (const chunk of response) {
                alive();
                buffer += chunk as string;
                let end: number;
                while ((end = buffer.indexOf("\n\n")) >= 0) {
                    const message = buffer.slice(0, end);
                    buffer = buffer.slice(end + 2);
                    const data = message.split("\n").find(line => line.startsWith("data:"));
                    if (message.includes("event: head") && data) onHead(JSON.parse(data.slice(5)).head);
                }
            }
            throw new Error("events: stream ended");
        } catch (error) {
            if (!signal.aborted) log(`events stream lost: ${error}`);
        } finally {
            clearTimeout(stale);
            signal.removeEventListener("abort", abort);
        }
        if (signal.aborted) break;
        await new Promise(resolve => setTimeout(resolve, backoff));
        backoff = Math.min(60_000, backoff * 2);
    }
}

export function runDaemon(
    config: DaemonConfig,
    log: (message: string) => void = console.error,
    driverCommand?: string,
): () => Promise<void> {
    const target: SyncTarget = { dir: config.dir, host: config.host, networkEnv: authEnv(config.token), log, driverCommand };
    const scheduler = new SyncScheduler(target, log);
    const stop = new AbortController();

    const watcher = watch(config.dir, { recursive: true }, (_event, filename) => {
        if (!filename) return scheduler.debounced();
        const path = filename.toString();
        if (path === ".git" || path.startsWith(".git/") || TEMP_FILE.test(basename(path))) return;
        scheduler.debounced();
    });

    void followServerEvents(
        config,
        async head => {
            // Our own push comes back as an event too; nothing to fetch then.
            if (head && head === (await resolveRef(config.dir, "HEAD"))) return;
            scheduler.now();
        },
        stop.signal,
        log,
    );

    const periodic = setInterval(() => scheduler.now(), PERIODIC_MS);
    scheduler.now();
    log(`ttm-sync watching ${config.dir} as ${config.host}, server ${config.server}`);

    return async () => {
        stop.abort();
        watcher.close();
        clearInterval(periodic);
        await scheduler.stop();
    };
}
