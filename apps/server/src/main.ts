import { startServer } from "./server.ts";

const token = process.env.TTM_TOKEN;
if (!token) {
    console.error("TTM_TOKEN is required");
    process.exit(1);
}

const { server, port } = await startServer(
    {
        repoPath: process.env.TTM_REPO ?? "/data/repos/notes.git",
        token,
        todoFiles: process.env.TTM_TODO_FILES?.split(",").map(f => f.trim()).filter(Boolean),
        log: console.error,
    },
    Number(process.env.PORT ?? 8080),
);
console.error(`ttm server listening on :${port}`);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
        server.close();
        server.closeAllConnections();
    });
}
