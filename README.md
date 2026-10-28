# ttm

Заметки и задачи из `~/Documents/Notes`: синк между машинами через git, сервер на `ttm.tihonove.dev`,
дальше мобилка.

| Путь | Что |
|---|---|
| `packages/git` | обёртка над git и 3-way merge текста без конфликтов |
| `packages/sync` | демон `ttm-sync`: watcher → commit → fetch/merge → push, merge-драйвер |
| `apps/server` | bare-репо заметок, git smart HTTP, SSE `/events`, API `/api/files`, `/api/file` |
| `deploy/` | kustomize-манифесты для кластера (Flux) |

## Как синкается

- Демон коммитит локальные правки через 2 с тишины (не позже 15 с), сразу пушит; сервер шлёт
  событие `head` по SSE — остальные машины забирают изменения за секунды. Раз в 5 мин — страховочный синк.
- Merge никогда не останавливается: все файлы идут через драйвер `ttm`
  - текст — построчный 3-way; соседние правки сливаются, при правке одной строки с двух сторон
    остаются обе версии (без маркеров и дублей);
  - бинарные и > 1 МБ — побеждает более поздняя правка, другая версия в истории;
  - изменение побеждает удаление; если всё же не сошлось — рядом `*.conflict-<host>-<время>.*`.
- Сервер запрещает force-push и удаление веток: история и есть бэкап.
- Сервер сам пишет файлы (`PUT /api/file?path=&base=`): коммит через plumbing + CAS на ref,
  если файл менялся после `base` — 3-way merge.

## Подключить машину

```bash
npm ci
node packages/sync/src/cli.ts init --dir ~/Documents/Notes --server https://ttm.tihonove.dev
# токен сервера → ~/.config/ttm/token (chmod 600)
node packages/sync/src/cli.ts once      # первый синк руками, посмотреть что всё ок
node packages/sync/src/cli.ts install   # systemd user unit ttm-sync.service
journalctl --user -u ttm-sync -f
```

## Разработка

```bash
npm test          # node --test, включая fuzz-синк трёх машин и e2e с сервером
npm run typecheck
```

Node ≥ 24 запускает `.ts` напрямую, сборки нет.
