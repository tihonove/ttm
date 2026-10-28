import type { TaskNode, TextNode, TodoNode } from "@ttm/parser/parse";

/** What GET /api/todos returns. */
export interface TodosResponse {
    head: string | null;
    files: { path: string; nodes: TodoNode[] }[];
}

export type Row = (TaskNode | TextNode) & { key: string };

export interface ListSection {
    key: string;
    file: string;
    title: string;
    data: Row[];
    /** Open tasks in the section, regardless of the filter. */
    open: number;
}

export type Filter = "open" | "all";

const CLOSED = new Set(["done", "cancelled"]);

export function fileTitle(path: string): string {
    return path.replace(/\.(md|todo)$/, "");
}

/**
 * One big list: a list section per file section, in file order. Lines before the first section
 * of a file go under the file name. With the "open" filter finished tasks are hidden, together
 * with everything nested under them; text lines always stay, so nothing written is invisible.
 */
export function buildSections(response: TodosResponse, filter: Filter): ListSection[] {
    const sections: ListSection[] = [];
    for (const { path, nodes } of response.files) {
        let current: ListSection | undefined;
        const start = (title: string) => {
            current = { key: `${path}:${sections.length}`, file: fileTitle(path), title, data: [], open: 0 };
            sections.push(current);
        };
        // Lines of tasks hidden by the filter, so their children are hidden too.
        const hidden = new Set<number>();
        for (const node of nodes) {
            if (node.kind === "section") {
                start(node.title);
                continue;
            }
            if (node.kind === "blank") continue;
            if (!current) start("");
            const section = current!;
            if (node.kind === "task") {
                if (!CLOSED.has(node.status)) section.open++;
                const parentHidden = node.parentLine !== undefined && hidden.has(node.parentLine);
                if (filter === "open" && (CLOSED.has(node.status) || parentHidden)) {
                    hidden.add(node.line);
                    continue;
                }
            }
            section.data.push({ ...node, key: `${path}:${node.line}` });
        }
    }
    return sections.filter(section => section.data.length > 0 || filter === "all");
}

export function countOpen(sections: ListSection[]): number {
    return sections.reduce((sum, section) => sum + section.open, 0);
}

/** What `ttm-sync pair` puts into its QR code. */
export const PAIRING_PREFIX = "ttm://pair?";

export function parsePairing(data: string): { server: string; token: string } | null {
    if (!data.startsWith(PAIRING_PREFIX)) return null;
    // By hand: React Native's URLSearchParams has long been only partly implemented.
    const params = new Map<string, string>();
    try {
        for (const pair of data.slice(PAIRING_PREFIX.length).split("&")) {
            const [key = "", value = ""] = pair.split("=").map(part => decodeURIComponent(part.replace(/\+/g, " ")));
            params.set(key, value);
        }
    } catch {
        return null;
    }
    const server = params.get("server");
    const token = params.get("token");
    if (!server || !token || !/^https?:\/\//.test(server)) return null;
    return { server, token };
}
