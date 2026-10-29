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
        updatesDir: process.env.TTM_UPDATES_DIR ?? "/app/build/updates",
        updatesPrivateKey: process.env.TTM_UPDATES_PRIVATE_KEY,
        appDir: process.env.TTM_APP_DIR ?? "/app/build/app",
        instructionsFile: process.env.TTM_INSTRUCTIONS_FILE,
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
