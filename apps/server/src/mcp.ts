// MCP (modelcontextprotocol.io) over Streamable HTTP, stateless: every POST carries one JSON-RPC
// message and gets plain JSON back, so the server keeps no sessions and no streams.
import { parse, type TodoNode } from "@ttm/parser/parse";
import { safePath, type NotesRepo } from "./repo.ts";

export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
/** Personal part of the instructions; larger files are cut so they cannot crowd out the chat. */
export const INSTRUCTIONS_LIMIT = 16 * 1024;
const NOTE_LIMIT = 256 * 1024;

export interface McpContext {
    repo: NotesRepo;
    todoFiles: string[];
    /** Notes file with the owner's own instructions for the agent, repo-relative. */
    instructionsFile: string;
}

type Filter = "open" | "all";

const CLOSED = new Set(["done", "cancelled"]);

/**
 * A todo file as the agent reads it: each line prefixed with its line number, blank lines dropped.
 * With the "open" filter finished tasks go, together with everything nested under them, and so do
 * sections left empty.
 */
export function todoText(source: string, filter: Filter): { text: string; open: number } {
    const hidden = new Set<number>();
    const kept: TodoNode[] = [];
    let open = 0;
    for (const node of parse(source).nodes) {
        if (node.kind === "blank") continue;
        if (node.kind === "task") {
            // A task under a finished one is finished too, whatever its own marker says.
            const finished = CLOSED.has(node.status) || (node.parentLine !== undefined && hidden.has(node.parentLine));
            if (finished) hidden.add(node.line);
            else open++;
            if (finished && filter === "open") continue;
        }
        kept.push(node);
    }
    const lines = kept.filter((node, i) => node.kind !== "section" || (kept[i + 1] !== undefined && kept[i + 1]!.kind !== "section"));
    return { text: lines.map(node => `${node.line}: ${node.raw}`).join("\n"), open };
}

function baseInstructions(todoFiles: string[]): string {
    return `ttm — заметки и списки дел пользователя: git-репозиторий markdown-файлов, который синхронизируется между его компьютерами и телефоном.

Списки дел: ${todoFiles.join(", ")}. Формат строк:
- \`- текст\` или \`* текст\` — открытая задача, \`+\` — сделана, \`x\` — отменена, \`?\` — вопрос.
- Вложенность задаётся отступом.
- Секции — заголовок \`# Название\` или строка \`Название:\`.

Инструменты:
- list_todos — открытые задачи по всем спискам (filter: "all" — вместе с закрытыми). Число в начале строки — номер строки в файле.
- list_notes и read_note — остальные заметки, например архив сделанного.
Инструменты только читают: менять заметки через ttm пока нельзя.`;
}

/** Built-in part plus the owner's file from the notes, read anew for every chat. */
export async function instructions(context: McpContext): Promise<string> {
    const base = baseInstructions(context.todoFiles);
    const personal = (await context.repo.readFile(context.instructionsFile))?.toString("utf8").trim();
    if (!personal) return base;
    const cut = personal.length > INSTRUCTIONS_LIMIT ? `${personal.slice(0, INSTRUCTIONS_LIMIT)}\n…` : personal;
    return `${base}\n\nЛичные инструкции пользователя (файл ${context.instructionsFile} в заметках):\n\n${cut}`;
}

const READ_ONLY = { readOnlyHint: true, openWorldHint: false };

const TOOLS = [
    {
        name: "list_todos",
        title: "Списки дел",
        description: "Задачи из списков дел пользователя, по файлам и секциям. По умолчанию только открытые.",
        inputSchema: {
            type: "object",
            properties: {
                filter: { type: "string", enum: ["open", "all"], description: '"open" — только открытые (по умолчанию), "all" — все' },
                file: { type: "string", description: "Только этот файл, например Home.md" },
            },
        },
        annotations: READ_ONLY,
    },
    {
        name: "list_notes",
        title: "Список заметок",
        description: "Все файлы в заметках с размерами.",
        inputSchema: { type: "object", properties: {} },
        annotations: READ_ONLY,
    },
    {
        name: "read_note",
        title: "Прочитать заметку",
        description: "Полный текст файла из заметок.",
        inputSchema: {
            type: "object",
            properties: { path: { type: "string", description: "Путь от корня заметок, например Archive.todo" } },
            required: ["path"],
        },
        annotations: READ_ONLY,
    },
];

interface ToolResult {
    content: { type: "text"; text: string }[];
    isError?: boolean;
}

const text = (value: string, isError = false): ToolResult => ({ content: [{ type: "text", text: value }], ...(isError ? { isError } : {}) });

async function callTool(context: McpContext, name: string, args: Record<string, unknown>): Promise<ToolResult | undefined> {
    const { repo } = context;
    const head = await repo.head();
    if (name === "list_todos") {
        const filter: Filter = args.filter === "all" ? "all" : "open";
        const files = typeof args.file === "string" ? [args.file] : context.todoFiles;
        const parts = [];
        for (const path of files) {
            const safe = safePath(path);
            const content = safe ? await repo.readFile(safe, head) : undefined;
            if (!content) {
                if (typeof args.file === "string") return text(`Нет такого файла: ${path}`, true);
                continue;
            }
            const todos = todoText(content.toString("utf8"), filter);
            parts.push(`## ${path} — открытых: ${todos.open}\n${todos.text}`);
        }
        return text(parts.join("\n\n") || "Списков дел нет.");
    }
    if (name === "list_notes") {
        const files = await repo.listFiles(head);
        return text(files.map(file => `${file.path} (${file.size} Б)`).join("\n") || "Заметок нет.");
    }
    if (name === "read_note") {
        const path = safePath(typeof args.path === "string" ? args.path : null);
        const content = path ? await repo.readFile(path, head) : undefined;
        if (!content) return text(`Нет такого файла: ${String(args.path)}`, true);
        if (content.includes(0)) return text(`${path} — бинарный файл, ${content.length} Б.`, true);
        if (content.length > NOTE_LIMIT) return text(`${content.subarray(0, NOTE_LIMIT).toString("utf8")}\n… (обрезано, всего ${content.length} Б)`);
        return text(content.toString("utf8"));
    }
    return undefined;
}

interface Request {
    jsonrpc: "2.0";
    id?: string | number | null;
    method: string;
    params?: Record<string, unknown>;
}

function isRequest(message: unknown): message is Request {
    if (typeof message !== "object" || message === null || Array.isArray(message)) return false;
    const m = message as Record<string, unknown>;
    return m.jsonrpc === "2.0" && typeof m.method === "string";
}

const error = (id: Request["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

/** Answers one JSON-RPC message; undefined for notifications, which get no answer. */
export async function handleMcp(message: unknown, context: McpContext): Promise<object | undefined> {
    if (!isRequest(message)) return error(null, -32600, "invalid request");
    const { id, method, params = {} } = message;
    if (id === undefined) return undefined;
    const result = (value: object) => ({ jsonrpc: "2.0", id, result: value });
    switch (method) {
        case "initialize": {
            const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
            return result({
                protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
                capabilities: { tools: {} },
                serverInfo: { name: "ttm", title: "ttm — заметки и дела", version: "1" },
                instructions: await instructions(context),
            });
        }
        case "ping":
            return result({});
        case "tools/list":
            return result({ tools: TOOLS });
        case "tools/call": {
            const args = typeof params.arguments === "object" && params.arguments !== null ? (params.arguments as Record<string, unknown>) : {};
            const called = await callTool(context, String(params.name), args);
            return called ? result(called) : error(id, -32602, `unknown tool: ${String(params.name)}`);
        }
        default:
            return error(id, -32601, `method not found: ${method}`);
    }
}
