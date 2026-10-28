#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, watchFile } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { isSea } from "node:sea";
import { parseArgs } from "node:util";
import QRCode from "qrcode";
import { authEnv, remoteUrl, runDaemon, type DaemonConfig } from "./daemon.ts";
import { runDriver, THEIRS_REF_ENV } from "./driver.ts";
import { prepareRepo, setRemote, syncOnce } from "./sync.ts";

/** Replaced at bundle time (scripts/build-sea.ts). */
declare const __TTM_VERSION__: string | undefined;
const VERSION = typeof __TTM_VERSION__ === "string" ? __TTM_VERSION__ : "dev";

const CONFIG_DIR = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "ttm");
const CONFIG_FILE = join(CONFIG_DIR, "sync.json");
const TOKEN_FILE = join(CONFIG_DIR, "token");
const UNIT_NAME = "ttm-sync.service";
/** How often the running daemon checks whether its binary was replaced by an update. */
const BINARY_CHECK_MS = 30_000;

type StoredConfig = Omit<DaemonConfig, "token">;

/** How to start this very program: the binary itself, or node with this script in development. */
function selfCommand(): string[] {
    return isSea() ? [process.execPath] : [process.execPath, process.argv[1]!];
}

function shellJoin(args: string[]): string {
    return args.map(arg => JSON.stringify(arg)).join(" ");
}

const driverCommand = () => shellJoin([...selfCommand(), "merge-driver"]);

async function loadConfig(): Promise<DaemonConfig> {
    const stored = JSON.parse(await readFile(CONFIG_FILE, "utf8")) as StoredConfig;
    const token = (process.env.TTM_TOKEN ?? (await readFile(TOKEN_FILE, "utf8"))).trim();
    return { ...stored, token };
}

async function init(args: string[]): Promise<void> {
    const { values } = parseArgs({
        args,
        options: {
            dir: { type: "string" },
            server: { type: "string" },
            host: { type: "string", default: hostname() },
        },
    });
    if (!values.dir || !values.server) throw new Error("usage: ttm-sync init --dir <notes dir> --server <url> [--host <name>]");
    const config: StoredConfig = { dir: resolve(values.dir), server: values.server, host: values.host! };
    await mkdir(CONFIG_DIR, { recursive: true });
    await writeFile(CONFIG_FILE, `${JSON.stringify(config, null, 4)}\n`);
    await prepareRepo({ ...config, driverCommand: driverCommand() });
    await setRemote(config.dir, remoteUrl(config.server));
    console.log(`configured ${CONFIG_FILE}`);
    if (!existsSync(TOKEN_FILE)) console.log(`put the server token into ${TOKEN_FILE} (chmod 600)`);
    console.log("next: ttm-sync once && ttm-sync install");
}

async function once(): Promise<void> {
    const config = await loadConfig();
    // Re-applied on every run so the merge driver always points at the current binary.
    await prepareRepo({ ...config, driverCommand: driverCommand() });
    const result = await syncOnce({ ...config, networkEnv: authEnv(config.token), log: console.error });
    console.log(JSON.stringify(result));
}

async function run(): Promise<void> {
    const config = await loadConfig();
    const command = driverCommand();
    await prepareRepo({ ...config, driverCommand: command });
    const stop = runDaemon(config, console.error, command);
    const exit = (reason: string) => {
        console.error(reason);
        void stop().then(() => process.exit(0));
    };
    for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => exit(`${signal}, stopping`));
    if (isSea()) {
        // An apt upgrade replaces the binary; exit between syncs and let systemd start the new one.
        watchFile(process.execPath, { interval: BINARY_CHECK_MS }, (current, previous) => {
            if (current.mtimeMs !== previous.mtimeMs || current.ino !== previous.ino) exit("binary updated, restarting");
        });
    }
}

async function install(): Promise<void> {
    const unitDir = join(homedir(), ".config", "systemd", "user");
    const unit = [
        "[Unit]",
        "Description=ttm notes sync (git)",
        "After=network-online.target",
        "",
        "[Service]",
        `ExecStart=${shellJoin([...selfCommand(), "run"])}`,
        "Restart=always",
        "RestartSec=5",
        "",
        "[Install]",
        "WantedBy=default.target",
        "",
    ].join("\n");
    await mkdir(unitDir, { recursive: true });
    await writeFile(join(unitDir, UNIT_NAME), unit);
    execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
    execFileSync("systemctl", ["--user", "enable", UNIT_NAME], { stdio: "inherit" });
    execFileSync("systemctl", ["--user", "restart", UNIT_NAME], { stdio: "inherit" });
    console.log(`installed and started ${UNIT_NAME}; logs: journalctl --user -u ${UNIT_NAME} -f`);
}

/** git's merge driver: `ttm-sync merge-driver %O %A %B %P`, run from the top of the working tree. */
async function mergeDriver(args: string[]): Promise<void> {
    const [basePath, oursPath, theirsPath, path] = args;
    if (!basePath || !oursPath || !theirsPath || !path) throw new Error("usage: ttm-sync merge-driver %O %A %B %P");
    // On failure the path stays unmerged; the daemon keeps ours and saves theirs as a conflict copy.
    await runDriver({ basePath, oursPath, theirsPath, path, repoDir: process.cwd(), theirsRef: process.env[THEIRS_REF_ENV] });
}

/** Shows a QR code the mobile app scans to connect: server and token, nothing else. */
async function pair(): Promise<void> {
    const config = await loadConfig();
    const url = `ttm://pair?server=${encodeURIComponent(config.server)}&token=${encodeURIComponent(config.token)}`;
    console.log(await QRCode.toString(url, { type: "terminal", small: true }));
    console.log("Scan it in the ttm app: Сканировать QR-код. The code holds the server token — don't share it.");
}

async function version(): Promise<void> {
    console.log(VERSION);
}

const commands: Record<string, (args: string[]) => Promise<void>> = {
    init,
    once,
    run,
    install,
    pair,
    "merge-driver": mergeDriver,
    "--version": version,
};
const [command = "", ...rest] = process.argv.slice(2);
const handler = commands[command];
if (!handler) {
    console.error(`usage: ttm-sync <${Object.keys(commands).join("|")}>`);
    process.exit(2);
}
handler(rest).catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
