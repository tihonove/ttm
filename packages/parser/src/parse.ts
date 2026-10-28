// Tolerant todo-file parser. Every line becomes a node and keeps its exact text, so nothing is
// ever hidden and render(parse(text)) === text. Unrecognized lines are plain text, not errors.

export type TaskStatus = "open" | "done" | "cancelled" | "question";

export interface SectionNode {
    kind: "section";
    /** 1-based line number. */
    line: number;
    raw: string;
    title: string;
}

export interface TaskNode {
    kind: "task";
    line: number;
    raw: string;
    /** Leading whitespace width, tabs counted as 4. */
    indent: number;
    marker: string;
    status: TaskStatus;
    text: string;
    /** Nesting level among tasks of the same section, 0 for top level. */
    depth: number;
    /** Line of the parent task, if nested. */
    parentLine?: number;
    /** Title of the enclosing section, if any. */
    section?: string;
}

export interface TextNode {
    kind: "text";
    line: number;
    raw: string;
    text: string;
    section?: string;
}

export interface BlankNode {
    kind: "blank";
    line: number;
    raw: string;
}

export type TodoNode = SectionNode | TaskNode | TextNode | BlankNode;

export interface TodoDocument {
    nodes: TodoNode[];
    /** Line terminator of the source, kept for rendering. */
    eol: "\n" | "\r\n";
    /** Whether the source ended with a line terminator. */
    finalEol: boolean;
}

const STATUS_BY_MARKER: Record<string, TaskStatus> = {
    "-": "open",
    "*": "open",
    "+": "done",
    x: "cancelled",
    X: "cancelled",
    "?": "question",
};

const TASK = /^([ \t ]*)([-*+xX?])[ \t ]+(.*)$/;
const MARKDOWN_HEADING = /^#{1,6}[ \t]+(.*?)[ \t]*:?[ \t]*$/;
/** `NOW:`, `FirstRelease:`, `BUGS INBOX:` — a short label on its own line ending with a colon. */
const LABEL = /^[ \t]{0,3}([^\s\-*+?#][^:]{0,58}?)[ \t]*:[ \t]*$/;

function indentWidth(whitespace: string): number {
    let width = 0;
    for (const char of whitespace) width += char === "\t" ? 4 : 1;
    return width;
}

function isBlank(raw: string): boolean {
    return raw.replace(/[\s ]/g, "") === "";
}

export function parse(source: string): TodoDocument {
    const eol = source.includes("\r\n") ? "\r\n" : "\n";
    const finalEol = source.endsWith(eol);
    const body = finalEol ? source.slice(0, -eol.length) : source;
    const lines = body === "" && !finalEol ? [] : body.split(eol);

    const nodes: TodoNode[] = [];
    let section: string | undefined;
    // Open tasks of the current section, innermost last, for nesting.
    let stack: TaskNode[] = [];
    lines.forEach((raw, index) => {
        const line = index + 1;
        if (isBlank(raw)) {
            nodes.push({ kind: "blank", line, raw });
            return;
        }
        const task = TASK.exec(raw);
        if (task) {
            const indent = indentWidth(task[1]!);
            while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) stack.pop();
            const parent = stack[stack.length - 1];
            const node: TaskNode = {
                kind: "task",
                line,
                raw,
                indent,
                marker: task[2]!,
                status: STATUS_BY_MARKER[task[2]!]!,
                text: task[3]!.trim(),
                depth: stack.length,
                ...(parent ? { parentLine: parent.line } : {}),
                ...(section !== undefined ? { section } : {}),
            };
            stack.push(node);
            nodes.push(node);
            return;
        }
        const heading = MARKDOWN_HEADING.exec(raw) ?? LABEL.exec(raw);
        if (heading) {
            section = heading[1]!.trim();
            stack = [];
            nodes.push({ kind: "section", line, raw, title: section });
            return;
        }
        nodes.push({ kind: "text", line, raw, text: raw.trim(), ...(section !== undefined ? { section } : {}) });
    });
    return { nodes, eol, finalEol };
}

export function render(document: TodoDocument): string {
    const text = document.nodes.map(node => node.raw).join(document.eol);
    return document.finalEol ? text + document.eol : text;
}
