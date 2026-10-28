import { spawn } from "node:child_process";

export interface GitResult {
    code: number;
    stdout: Buffer;
    stderr: string;
}

export interface GitOptions {
    env?: NodeJS.ProcessEnv;
    input?: string | Buffer;
}

export class GitError extends Error {
    readonly result: GitResult;
    constructor(args: string[], result: GitResult) {
        super(`git ${args.join(" ")} exited with ${result.code}: ${result.stderr.trim()}`);
        this.result = result;
    }
}

export function gitRaw(cwd: string, args: string[], options: GitOptions = {}): Promise<GitResult> {
    return new Promise((resolve, reject) => {
        const child = spawn("git", args, {
            cwd,
            env: { ...process.env, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0", ...options.env },
            stdio: ["pipe", "pipe", "pipe"],
        });
        const out: Buffer[] = [];
        const err: Buffer[] = [];
        child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
        child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
        child.on("error", reject);
        child.on("close", code => {
            resolve({ code: code ?? -1, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString("utf8") });
        });
        child.stdin.on("error", () => {});
        child.stdin.end(options.input ?? "");
    });
}

/** Runs git and returns trimmed stdout; throws GitError on a non-zero exit. */
export async function git(cwd: string, args: string[], options: GitOptions = {}): Promise<string> {
    const result = await gitRaw(cwd, args, options);
    if (result.code !== 0) throw new GitError(args, result);
    return result.stdout.toString("utf8").trimEnd();
}

/** Returns the object id a ref points to, or undefined when the ref does not exist. */
export async function resolveRef(cwd: string, ref: string): Promise<string | undefined> {
    const result = await gitRaw(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return result.code === 0 ? result.stdout.toString("utf8").trim() : undefined;
}

/** Passes config to a single git invocation via env, so nothing (e.g. a token) lands in .git/config. */
export function configEnv(entries: Record<string, string>): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    const pairs = Object.entries(entries);
    env.GIT_CONFIG_COUNT = String(pairs.length);
    pairs.forEach(([key, value], i) => {
        env[`GIT_CONFIG_KEY_${i}`] = key;
        env[`GIT_CONFIG_VALUE_${i}`] = value;
    });
    return env;
}
