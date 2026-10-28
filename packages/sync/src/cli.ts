#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { authEnv, remoteUrl, runDaemon, type DaemonConfig } from "./daemon.ts";
import { prepareRepo, setRemote, syncOnce } from "./sync.ts";

const CONFIG_DIR = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "ttm");
const CONFIG_FILE = join(CONFIG_DIR, "sync.json");
const TOKEN_FILE = join(CONFIG_DIR, "token");
const UNIT_NAME = "ttm-sync.service";

type StoredConfig = Omit<DaemonConfig, "token">;

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
    await prepareRepo(config);
    await setRemote(config.dir, remoteUrl(config.server));
    console.log(`configured ${CONFIG_FILE}`);
    console.log(`put the server token into ${TOKEN_FILE} (chmod 600), then: ttm-sync once`);
}

async function once(): Promise<void> {
    const config = await loadConfig();
    // Re-applied on every run so a moved checkout of this tool keeps the merge driver path right.
    await prepareRepo(config);
    const result = await syncOnce({ ...config, networkEnv: authEnv(config.token), log: console.error });
    console.log(JSON.stringify(result));
}

async function run(): Promise<void> {
    const config = await loadConfig();
    await prepareRepo(config);
    const stop = runDaemon(config);
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
        process.on(signal, () => {
            stop();
            process.exit(0);
        });
    }
}

async function install(): Promise<void> {
    const cli = fileURLToPath(import.meta.url);
    const unitDir = join(homedir(), ".config", "systemd", "user");
    const unit = [
        "[Unit]",
        "Description=ttm notes sync (git)",
        "After=network-online.target",
        "",
        "[Service]",
        `ExecStart=${process.execPath} ${cli} run`,
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
    execFileSync("systemctl", ["--user", "enable", "--now", UNIT_NAME], { stdio: "inherit" });
    console.log(`installed and started ${UNIT_NAME}; logs: journalctl --user -u ${UNIT_NAME} -f`);
}

const commands: Record<string, (args: string[]) => Promise<void>> = { init, once, run, install };
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
