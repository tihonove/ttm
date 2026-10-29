import { afterAll, beforeAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleMcp, INSTRUCTIONS_LIMIT, instructions, todoText, type McpContext } from "../src/mcp.ts";
import { ALLOWED_REDIRECT_URIS, OAuth } from "../src/oauth.ts";
import { NotesRepo } from "../src/repo.ts";
import { startServer } from "../src/server.ts";

const HOME = `Дом:
- купить хлеб
  - белый
+ вынести мусор
  - это уже не нужно
x покрасить забор

Готово:
+ всё сделано
? спросить соседа
  текст под вопросом
`;

async function seededRepo(root: string, files: Record<string, string | Buffer>): Promise<NotesRepo> {
    const repo = new NotesRepo(join(root, "notes.git"));
    await repo.init();
    for (const [path, content] of Object.entries(files)) {
        await repo.writeFile({ path, content: Buffer.from(content), message: `add ${path}` });
    }
    return repo;
}

describe("todoText", () => {
    it("drops finished tasks with what is nested under them", () => {
        const { text, open } = todoText(HOME, "open");
        assert.equal(open, 3);
        assert.equal(text, ["1: Дом:", "2: - купить хлеб", "3:   - белый", "8: Готово:", "10: ? спросить соседа", "11:   текст под вопросом"].join("\n"));
    });

    it("keeps everything but blank lines with the 'all' filter", () => {
        const { text } = todoText(HOME, "all");
        assert.equal(text.split("\n").length, 10);
        assert.match(text, /^4: \+ вынести мусор$/m);
        assert.match(text, /^8: Готово:$/m);
    });

    it("drops a trailing empty section", () => {
        assert.equal(todoText("- a\nПусто:\n+ b\n", "open").text, "1: - a");
    });
});

describe("mcp", () => {
    let root: string;
    let context: McpContext;
    const call = (method: string, params?: object, id: number | null = 1) =>
        handleMcp({ jsonrpc: "2.0", ...(id === null ? {} : { id }), method, ...(params ? { params } : {}) }, context);
    const toolText = async (name: string, args: object = {}) => {
        const answer = (await call("tools/call", { name, arguments: args })) as { result: { content: { text: string }[]; isError?: boolean } };
        return { text: answer.result.content[0]!.text, isError: answer.result.isError ?? false };
    };

    beforeAll(async () => {
        root = await mkdtemp(join(tmpdir(), "ttm-mcp-test-"));
        const repo = await seededRepo(root, {
            "Home.md": HOME,
            "Work.md": "- отчёт\n+ планёрка\n",
            "Archive.todo": "+ старое\n",
            "pic.png": Buffer.from([0x89, 0x50, 0, 1]),
            "TTM.md": "Называй меня Женя.\n",
        });
        context = { repo, todoFiles: ["Home.md", "Missing.md", "Work.md"], instructionsFile: "TTM.md" };
    });
    afterAll(() => rm(root, { recursive: true, force: true }));

    it("introduces itself with the built-in and personal instructions", async () => {
        const answer = (await call("initialize", { protocolVersion: "2025-06-18", capabilities: {} })) as { id: number; result: Record<string, any> };
        assert.equal(answer.id, 1);
        assert.equal(answer.result.protocolVersion, "2025-06-18");
        assert.deepEqual(answer.result.capabilities, { tools: {} });
        assert.equal(answer.result.serverInfo.name, "ttm");
        assert.match(answer.result.instructions, /Списки дел: Home\.md, Missing\.md, Work\.md\./);
        assert.match(answer.result.instructions, /файл TTM\.md в заметках\):\n\nНазывай меня Женя\.$/);
    });

    it("answers an unknown protocol version with its newest one", async () => {
        const answer = (await call("initialize", { protocolVersion: "1999-01-01" })) as { result: { protocolVersion: string } };
        assert.equal(answer.result.protocolVersion, "2025-11-25");
    });

    it("sends only the built-in part without a personal file, and cuts a huge one", async () => {
        const repo = context.repo;
        assert.doesNotMatch(await instructions({ ...context, instructionsFile: "Nope.md" }), /Личные/);
        await repo.writeFile({ path: "Big.md", content: Buffer.from("я".repeat(INSTRUCTIONS_LIMIT + 10)), message: "big" });
        const big = await instructions({ ...context, instructionsFile: "Big.md" });
        assert.ok(big.endsWith(`${"я".repeat(INSTRUCTIONS_LIMIT)}\n…`));
    });

    it("lists three read-only tools", async () => {
        const answer = (await call("tools/list")) as { result: { tools: { name: string; annotations: { readOnlyHint: boolean } }[] } };
        assert.deepEqual(answer.result.tools.map(t => t.name), ["list_todos", "list_notes", "read_note"]);
        assert.ok(answer.result.tools.every(t => t.annotations.readOnlyHint));
    });

    it("lists open todos of every list, skipping missing files", async () => {
        const { text, isError } = await toolText("list_todos");
        assert.equal(isError, false);
        assert.match(text, /^## Home\.md — открытых: 3\n1: Дом:/);
        assert.match(text, /\n\n## Work\.md — открытых: 1\n1: - отчёт$/);
        assert.doesNotMatch(text, /Missing|планёрка/);
    });

    it("lists all todos of one file, and says when the file is not there", async () => {
        assert.match((await toolText("list_todos", { file: "Work.md", filter: "all" })).text, /^## Work\.md — открытых: 1\n1: - отчёт\n2: \+ планёрка$/);
        assert.deepEqual(await toolText("list_todos", { file: "../etc/passwd" }), { text: "Нет такого файла: ../etc/passwd", isError: true });
        assert.equal((await handleMcp({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_todos" } }, { ...context, todoFiles: [] }) as any).result.content[0].text, "Списков дел нет.");
    });

    it("lists and reads notes", async () => {
        assert.match((await toolText("list_notes")).text, /^Archive\.todo \(15 Б\)$/m);
        assert.deepEqual(await toolText("read_note", { path: "Archive.todo" }), { text: "+ старое\n", isError: false });
        assert.deepEqual(await toolText("read_note", { path: "pic.png" }), { text: "pic.png — бинарный файл, 4 Б.", isError: true });
        assert.equal((await toolText("read_note", { path: "nope.md" })).isError, true);
        assert.equal((await toolText("read_note", {})).text, "Нет такого файла: undefined");
    });

    it("cuts a huge note", async () => {
        await context.repo.writeFile({ path: "Huge.md", content: Buffer.alloc(300 * 1024, "a"), message: "huge" });
        assert.match((await toolText("read_note", { path: "Huge.md" })).text, /\n… \(обрезано, всего 307200 Б\)$/);
    });

    it("answers ping, ignores notifications and reports errors", async () => {
        assert.deepEqual(await call("ping"), { jsonrpc: "2.0", id: 1, result: {} });
        assert.equal(await call("notifications/initialized", undefined, null), undefined);
        assert.deepEqual(await call("resources/list"), { jsonrpc: "2.0", id: 1, error: { code: -32601, message: "method not found: resources/list" } });
        assert.deepEqual(await call("tools/call", { name: "rm" }), { jsonrpc: "2.0", id: 1, error: { code: -32602, message: "unknown tool: rm" } });
        for (const bad of [null, [], { jsonrpc: "1.0", method: "ping" }, { jsonrpc: "2.0", id: 1 }]) {
            assert.deepEqual(await handleMcp(bad, context), { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } });
        }
    });
});

describe("oauth", () => {
    const REDIRECT = ALLOWED_REDIRECT_URIS[0]!;
    const verifier = "v".repeat(50);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    let clock = 1_800_000_000_000;
    const oauth = new OAuth("server-token", token => token === "server-token", () => clock);
    const clientId = (JSON.parse(oauth.register({ redirect_uris: [REDIRECT] }).body) as { client_id: string }).client_id;
    const authorizeParams = (overrides: Record<string, string> = {}) =>
        new URLSearchParams({
            client_id: clientId,
            redirect_uri: REDIRECT,
            response_type: "code",
            state: "st",
            code_challenge: challenge,
            code_challenge_method: "S256",
            token: "server-token",
            ...overrides,
        });
    const codeFrom = (reply: { headers: Record<string, string> }) => new URL(reply.headers.location!).searchParams.get("code")!;
    const exchange = (code: string, overrides: Record<string, string> = {}) =>
        oauth.token(new URLSearchParams({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier, ...overrides }));

    it("registers only claude.ai", () => {
        assert.equal(oauth.register({ redirect_uris: [REDIRECT] }).status, 201);
        for (const body of [null, {}, { redirect_uris: [] }, { redirect_uris: [REDIRECT, "https://evil.example/cb"] }]) {
            assert.equal(oauth.register(body).status, 400);
        }
    });

    it("shows the token page only for a valid request", () => {
        const page = oauth.authorizePage(authorizeParams());
        assert.equal(page.status, 200);
        assert.match(page.body, /name="state" value="st"/);
        assert.match(page.body, /type="password"/);
        const cases: Record<string, string>[] = [
            { client_id: "forged.sig" },
            { redirect_uri: "https://evil.example/cb" },
            { response_type: "token" },
            { code_challenge_method: "plain" },
            { code_challenge: "" },
        ];
        for (const overrides of cases) {
            const reply = oauth.authorizePage(authorizeParams(overrides));
            assert.equal(reply.status, 400, JSON.stringify(overrides));
            assert.doesNotMatch(reply.body, /<form/);
        }
    });

    it("refuses a wrong token and asks again", () => {
        const reply = oauth.authorize(authorizeParams({ token: "guess" }));
        assert.equal(reply.status, 401);
        assert.match(reply.body, /Токен не подошёл/);
        assert.equal(oauth.authorize(authorizeParams({ redirect_uri: "https://evil.example/cb" })).status, 400);
    });

    it("trades a code for tokens once, with the PKCE verifier", () => {
        const reply = oauth.authorize(authorizeParams());
        assert.equal(reply.status, 302);
        const location = new URL(reply.headers.location!);
        assert.equal(`${location.origin}${location.pathname}`, REDIRECT);
        assert.equal(location.searchParams.get("state"), "st");
        const code = codeFrom(reply);

        assert.equal(exchange(code, { code_verifier: "wrong" }).status, 400);
        assert.equal(exchange(code, { client_id: "other" }).status, 400);
        assert.equal(exchange(code, { redirect_uri: ALLOWED_REDIRECT_URIS[1]! }).status, 400);
        const tokens = exchange(code);
        assert.equal(tokens.status, 200);
        assert.equal(tokens.headers["cache-control"], "no-store");
        const body = JSON.parse(tokens.body) as { access_token: string; refresh_token: string; token_type: string };
        assert.equal(body.token_type, "Bearer");
        assert.equal(oauth.isAccessToken(body.access_token), true);
        assert.equal(oauth.isAccessToken(body.refresh_token), false);
        assert.equal(oauth.isAccessToken(clientId), false);
        assert.equal(exchange(code).status, 400, "a code works once");
    });

    it("leaves state out when the client sent none", () => {
        assert.equal(new URL(oauth.authorize(authorizeParams({ state: "" })).headers.location!).searchParams.has("state"), false);
    });

    it("expires codes and access tokens, and refreshes", () => {
        const code = codeFrom(oauth.authorize(authorizeParams()));
        const { access_token, refresh_token } = JSON.parse(exchange(code).body) as { access_token: string; refresh_token: string };
        const late = codeFrom(oauth.authorize(authorizeParams()));
        clock += 2 * 60 * 60 * 1000;
        assert.equal(exchange(late).status, 400);
        assert.equal(oauth.isAccessToken(access_token), false);
        const refreshed = oauth.token(new URLSearchParams({ grant_type: "refresh_token", refresh_token }));
        assert.equal(refreshed.status, 200);
        assert.equal(oauth.isAccessToken((JSON.parse(refreshed.body) as { access_token: string }).access_token), true);
        assert.equal(oauth.token(new URLSearchParams({ grant_type: "refresh_token", refresh_token: access_token })).status, 400);
        assert.deepEqual(JSON.parse(oauth.token(new URLSearchParams({ grant_type: "password" })).body), { error: "unsupported_grant_type" });
    });

    it("trusts nothing signed with another server token", () => {
        const other = new OAuth("rotated", () => true, () => clock);
        assert.equal(other.authorizePage(authorizeParams()).status, 400);
    });
});

describe("server: MCP for claude.ai", () => {
    let root: string;
    let server: Server;
    let url: string;
    const logs: string[] = [];

    beforeAll(async () => {
        root = await mkdtemp(join(tmpdir(), "ttm-mcp-server-"));
        await seededRepo(join(root, "repos"), { "Home.md": "- купить хлеб\n" });
        const started = await startServer({ repoPath: join(root, "repos", "notes.git"), token: "secret", log: m => logs.push(m) }, 0);
        server = started.server;
        url = `http://127.0.0.1:${started.port}`;
    });
    afterAll(async () => {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        await rm(root, { recursive: true, force: true });
    });

    const rpc = (body: string, token: string) =>
        fetch(`${url}/mcp`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body });

    it("goes through discovery, registration, consent and token exchange like claude.ai", async () => {
        const unauthorized = await fetch(`${url}/mcp`, { method: "POST", headers: { "x-forwarded-proto": "https" }, body: "{}" });
        assert.equal(unauthorized.status, 401);
        const metadataUrl = /resource_metadata="([^"]+)"/.exec(unauthorized.headers.get("www-authenticate")!)![1]!;
        assert.match(metadataUrl, /^https:\/\/127\.0\.0\.1:\d+\/\.well-known\/oauth-protected-resource$/);

        const resource = await (await fetch(`${url}/.well-known/oauth-protected-resource/mcp`)).json();
        assert.equal(resource.resource, `${url}/mcp`);
        const server = await (await fetch(`${resource.authorization_servers[0]}/.well-known/oauth-authorization-server`)).json();
        assert.deepEqual(server.code_challenge_methods_supported, ["S256"]);

        assert.equal((await fetch(server.registration_endpoint, { method: "POST", body: "not json" })).status, 400);
        const registered = await fetch(server.registration_endpoint, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ client_name: "Claude", redirect_uris: [ALLOWED_REDIRECT_URIS[0]] }),
        });
        assert.equal(registered.status, 201);
        const { client_id } = await registered.json();

        const verifier = "x".repeat(64);
        const params = new URLSearchParams({
            client_id,
            redirect_uri: ALLOWED_REDIRECT_URIS[0]!,
            response_type: "code",
            state: "s1",
            code_challenge: createHash("sha256").update(verifier).digest("base64url"),
            code_challenge_method: "S256",
        });
        assert.equal((await fetch(`${server.authorization_endpoint}?${params}`)).status, 200);
        params.set("token", "secret");
        const consent = await fetch(server.authorization_endpoint, { method: "POST", body: params, redirect: "manual" });
        assert.equal(consent.status, 302);
        const code = new URL(consent.headers.get("location")!).searchParams.get("code")!;

        const tokens = await (
            await fetch(server.token_endpoint, {
                method: "POST",
                body: new URLSearchParams({ grant_type: "authorization_code", code, client_id, redirect_uri: ALLOWED_REDIRECT_URIS[0]!, code_verifier: verifier }),
            })
        ).json();

        const init = await rpc(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }), tokens.access_token);
        assert.equal(init.status, 200);
        assert.match((await init.json()).result.instructions, /ttm/);
        assert.ok(logs.includes("mcp: initialize"));
        const todos = await rpc(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_todos" } }), tokens.access_token);
        assert.match((await todos.json()).result.content[0].text, /1: - купить хлеб/);

        // The connector's token opens /mcp only.
        assert.equal((await fetch(`${url}/api/todos`, { headers: { authorization: `Bearer ${tokens.access_token}` } })).status, 401);
    });

    it("also takes the server token, as Claude Code would send it", async () => {
        const answer = await rpc(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }), "secret");
        assert.deepEqual(await answer.json(), { jsonrpc: "2.0", id: 1, result: {} });
    });

    it("accepts notifications, refuses garbage and other methods", async () => {
        assert.equal((await rpc(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }), "secret")).status, 202);
        const garbage = await rpc("{", "secret");
        assert.equal(garbage.status, 400);
        assert.equal((await garbage.json()).error.code, -32700);
        const get = await fetch(`${url}/mcp`, { headers: { authorization: "Bearer secret" } });
        assert.equal(get.status, 405);
        assert.equal(get.headers.get("allow"), "POST");
    });
});
