// OAuth 2.1 for claude.ai custom connectors: metadata discovery, dynamic client registration,
// an authorize page where the owner enters the server token once, and a PKCE code exchange.
// Nothing is stored: clients, codes and tokens are HMAC-signed with a key derived from the server
// token, so changing the server token revokes every connector at once.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { escape } from "./app-page.ts";

/** Only claude.ai may connect: registration and authorization refuse any other redirect. */
export const ALLOWED_REDIRECT_URIS = ["https://claude.ai/api/mcp/auth_callback", "https://claude.com/api/mcp/auth_callback"];

const CODE_TTL = 5 * 60;
const ACCESS_TTL = 60 * 60;
const REFRESH_TTL = 90 * 24 * 60 * 60;

type Grant =
    | { typ: "client"; redirect_uris: string[] }
    | { typ: "code"; client_id: string; redirect_uri: string; challenge: string; exp: number; nonce: string }
    | { typ: "access"; exp: number }
    | { typ: "refresh"; client_id: string; exp: number };

export interface Reply {
    status: number;
    headers: Record<string, string>;
    body: string;
}

const b64 = (data: Buffer | string) => Buffer.from(data).toString("base64url");

function jsonReply(status: number, body: unknown): Reply {
    return { status, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(body) };
}

function htmlReply(status: number, body: string): Reply {
    return { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }, body };
}

export class OAuth {
    private readonly key: Buffer;
    private readonly now: () => number;
    private readonly tokenMatches: (token: string) => boolean;
    /** Codes already exchanged, until they expire: a code works once. */
    private readonly usedCodes = new Map<string, number>();

    constructor(serverToken: string, tokenMatches: (token: string) => boolean, now: () => number = Date.now) {
        this.key = createHmac("sha256", serverToken).update("ttm-oauth-v1").digest();
        this.tokenMatches = tokenMatches;
        this.now = now;
    }

    private seconds(): number {
        return Math.floor(this.now() / 1000);
    }

    private sign(grant: Grant): string {
        const payload = b64(JSON.stringify(grant));
        return `${payload}.${b64(createHmac("sha256", this.key).update(payload).digest())}`;
    }

    private verify<T extends Grant["typ"]>(token: unknown, typ: T): Extract<Grant, { typ: T }> | undefined {
        if (typeof token !== "string") return undefined;
        const [payload = "", sig = ""] = token.split(".");
        const expected = createHmac("sha256", this.key).update(payload).digest();
        const given = Buffer.from(sig, "base64url");
        if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
        const grant = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Grant;
        if (grant.typ !== typ) return undefined;
        if ("exp" in grant && grant.exp <= this.seconds()) return undefined;
        return grant as Extract<Grant, { typ: T }>;
    }

    /** RFC 9728: where the connector learns which authorization server guards /mcp. */
    resourceMetadata(origin: string): Reply {
        return jsonReply(200, { resource: `${origin}/mcp`, authorization_servers: [origin], bearer_methods_supported: ["header"] });
    }

    /** RFC 8414. */
    serverMetadata(origin: string): Reply {
        return jsonReply(200, {
            issuer: origin,
            authorization_endpoint: `${origin}/oauth/authorize`,
            token_endpoint: `${origin}/oauth/token`,
            registration_endpoint: `${origin}/oauth/register`,
            response_types_supported: ["code"],
            grant_types_supported: ["authorization_code", "refresh_token"],
            code_challenge_methods_supported: ["S256"],
            token_endpoint_auth_methods_supported: ["none"],
        });
    }

    /** RFC 7591: the client id is the signed list of its redirect URIs, so nothing is stored. */
    register(body: unknown): Reply {
        const uris = (body as { redirect_uris?: unknown } | null)?.redirect_uris;
        if (!Array.isArray(uris) || uris.length === 0 || !uris.every(uri => ALLOWED_REDIRECT_URIS.includes(uri))) {
            return jsonReply(400, { error: "invalid_redirect_uri", error_description: "only claude.ai may connect" });
        }
        const redirect_uris = uris as string[];
        return jsonReply(201, {
            client_id: this.sign({ typ: "client", redirect_uris }),
            client_id_issued_at: this.seconds(),
            redirect_uris,
            token_endpoint_auth_method: "none",
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
        });
    }

    private checkAuthorize(params: URLSearchParams): string | undefined {
        const client = this.verify(params.get("client_id"), "client");
        if (!client) return "Неизвестный клиент.";
        if (!client.redirect_uris.includes(params.get("redirect_uri") ?? "")) return "Неверный адрес возврата.";
        if (params.get("response_type") !== "code") return "Поддерживается только response_type=code.";
        if (!params.get("code_challenge") || params.get("code_challenge_method") !== "S256") return "Нужен PKCE с S256.";
        return undefined;
    }

    /** GET /oauth/authorize: the page that asks for the server token. */
    authorizePage(params: URLSearchParams): Reply {
        const problem = this.checkAuthorize(params);
        if (problem) return htmlReply(400, page(problem));
        return htmlReply(200, page(undefined, params));
    }

    /** POST /oauth/authorize: the token checks out, so send claude.ai back with a code. */
    authorize(form: URLSearchParams): Reply {
        const problem = this.checkAuthorize(form);
        if (problem) return htmlReply(400, page(problem));
        if (!this.tokenMatches(form.get("token") ?? "")) return htmlReply(401, page(undefined, form, "Токен не подошёл."));
        const code = this.sign({
            typ: "code",
            client_id: form.get("client_id")!,
            redirect_uri: form.get("redirect_uri")!,
            challenge: form.get("code_challenge")!,
            exp: this.seconds() + CODE_TTL,
            // Two codes for the same request must differ, or using one would burn the other.
            nonce: b64(randomBytes(12)),
        });
        const location = new URL(form.get("redirect_uri")!);
        location.searchParams.set("code", code);
        const state = form.get("state");
        if (state) location.searchParams.set("state", state);
        return { status: 302, headers: { location: location.toString(), "cache-control": "no-store" }, body: "" };
    }

    private tokens(client_id: string): Reply {
        return jsonReply(200, {
            access_token: this.sign({ typ: "access", exp: this.seconds() + ACCESS_TTL }),
            token_type: "Bearer",
            expires_in: ACCESS_TTL,
            refresh_token: this.sign({ typ: "refresh", client_id, exp: this.seconds() + REFRESH_TTL }),
        });
    }

    /** POST /oauth/token. */
    token(form: URLSearchParams): Reply {
        const invalid = (description: string) => jsonReply(400, { error: "invalid_grant", error_description: description });
        const grantType = form.get("grant_type");
        if (grantType === "authorization_code") {
            const raw = form.get("code") ?? "";
            const code = this.verify(raw, "code");
            if (!code || this.usedCodes.has(raw)) return invalid("code is invalid, expired or used");
            if (code.client_id !== form.get("client_id") || code.redirect_uri !== form.get("redirect_uri")) {
                return invalid("code was issued to another client");
            }
            const verifier = form.get("code_verifier") ?? "";
            if (b64(createHash("sha256").update(verifier).digest()) !== code.challenge) return invalid("PKCE check failed");
            for (const [used, exp] of this.usedCodes) if (exp <= this.seconds()) this.usedCodes.delete(used);
            this.usedCodes.set(raw, code.exp);
            return this.tokens(code.client_id);
        }
        if (grantType === "refresh_token") {
            const refresh = this.verify(form.get("refresh_token"), "refresh");
            if (!refresh) return invalid("refresh token is invalid or expired");
            return this.tokens(refresh.client_id);
        }
        return jsonReply(400, { error: "unsupported_grant_type" });
    }

    isAccessToken(token: string): boolean {
        return this.verify(token, "access") !== undefined;
    }
}

const FIELDS = ["client_id", "redirect_uri", "response_type", "state", "code_challenge", "code_challenge_method"];

function page(problem: string | undefined, params?: URLSearchParams, retry?: string): string {
    const body = problem
        ? `<p class="error">${escape(problem)}</p>`
        : `<p>claude.ai просит доступ к заметкам: читать списки дел и файлы.</p>
  <form method="post" action="/oauth/authorize">
    ${FIELDS.map(name => `<input type="hidden" name="${name}" value="${escape(params!.get(name) ?? "")}">`).join("\n    ")}
    <label for="token">Токен сервера — <code>~/.config/ttm/token</code></label>
    <input id="token" name="token" type="password" autocomplete="off" required autofocus>
    ${retry ? `<p class="error">${escape(retry)}</p>` : ""}
    <button type="submit">Разрешить</button>
  </form>`;
    return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ttm — доступ</title>
<style>
  :root { --bg: #fff; --text: #16161a; --muted: #7a7a85; --accent: #3b6fe0; --error: #c62828; --line: #d5d5dc; }
  @media (prefers-color-scheme: dark) { :root { --bg: #121214; --text: #ececf0; --muted: #8b8b96; --accent: #7aa2ff; --error: #ff6b6b; --line: #33333a; } }
  body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.5 system-ui, sans-serif; }
  main { max-width: 420px; margin: 0 auto; padding: 48px 16px; }
  h1 { font-size: 28px; margin: 0 0 16px; }
  label { display: block; margin: 24px 0 8px; color: var(--muted); }
  input[type=password] { box-sizing: border-box; width: 100%; padding: 12px; border: 1px solid var(--line); border-radius: 10px;
                         background: transparent; color: var(--text); font: inherit; }
  button { width: 100%; margin-top: 16px; padding: 14px; border: 0; border-radius: 10px; background: var(--accent); color: #fff;
           font: inherit; font-weight: 600; }
  .error { color: var(--error); }
</style>
</head>
<body>
<main>
  <h1>ttm</h1>
  ${body}
</main>
</body>
</html>
`;
}
