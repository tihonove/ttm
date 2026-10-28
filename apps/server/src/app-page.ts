import type { Update } from "./updates.ts";

export const APK_NAME = "ttm.apk";

function escape(text: string): string {
    return text.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
}

/** The page a phone opens to install the app: one download button and what it will get. */
export function appPage({ apkSize, update }: { apkSize: number | undefined; update: Update | undefined }): string {
    const download =
        apkSize === undefined
            ? `<p class="muted">В этой сборке сервера APK нет.</p>`
            : `<a class="button" href="/app/${APK_NAME}">Скачать APK</a>
               <p class="muted">${(apkSize / 1024 / 1024).toFixed(1)} МБ · Android, arm64</p>`;
    const js = update
        ? `<p class="muted">Код приложения обновляется сам: версия ${escape(update.createdAt.slice(0, 16).replace("T", " "))} UTC,
           runtime ${escape(update.runtimeVersion)}.</p>`
        : "";
    return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ttm</title>
<style>
  :root { --bg: #fff; --text: #16161a; --muted: #7a7a85; --accent: #3b6fe0; }
  @media (prefers-color-scheme: dark) { :root { --bg: #121214; --text: #ececf0; --muted: #8b8b96; --accent: #7aa2ff; } }
  body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.5 system-ui, sans-serif; }
  main { max-width: 420px; margin: 0 auto; padding: 48px 16px; }
  h1 { font-size: 28px; margin: 0 0 4px; }
  .muted { color: var(--muted); }
  .button { display: block; margin: 32px 0 8px; padding: 14px; border-radius: 10px; text-align: center;
            background: var(--accent); color: #fff; font-weight: 600; text-decoration: none; }
</style>
</head>
<body>
<main>
  <h1>ttm</h1>
  <p class="muted">Задачи из заметок на телефоне.</p>
  ${download}
  ${js}
  <p class="muted">После установки: на компьютере <code>ttm-sync pair</code>, в приложении «Сканировать QR-код».</p>
</main>
</body>
</html>
`;
}
