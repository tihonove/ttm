# ttm

Заметки и задачи из `~/Documents/Notes`: синк между машинами через git, сервер на `ttm.tihonove.dev`,
дальше мобилка.

| Путь | Что |
|---|---|
| `packages/git` | обёртка над git и 3-way merge текста без конфликтов (для сервера) |
| `packages/sync` | демон `ttm-sync` на Go: watcher → commit → fetch/merge → push, merge-драйвер |
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
curl -fsSL https://tihonove.github.io/apt/install.sh | sudo sh -s -- ttm-sync
ttm-sync init --dir ~/Documents/Notes --server https://ttm.tihonove.dev
# токен сервера → ~/.config/ttm/token (chmod 600)
ttm-sync once      # первый синк руками, посмотреть что всё ок
ttm-sync install   # systemd user unit ttm-sync.service
journalctl --user -u ttm-sync -f
```

Обновления — обычный `apt upgrade`: он подменяет бинарь, демон замечает это и перезапускается через systemd.
Из исходников — то же самое через `go -C packages/sync run . <команда>`.

Машина со старой версией на Node из `~/.local/bin`: `apt upgrade` её не заменит, юнит указывает на старый
путь. Поставить пакет, выполнить `/usr/bin/ttm-sync install` и удалить `~/.local/bin/ttm-sync`.

## Релиз

```bash
scripts/release          # v0.1.0 → v0.1.1; minor | major | 0.4.2; -n — посмотреть, что выйдет
```

Скрипт ставит тег `vX.Y.Z`, workflow `release` гоняет тесты, собирает статические бинари (`npm run build:bin`) и
`ttm-sync_X.Y.Z_{amd64,arm64}.deb` (`npm run build:deb`) в GitHub Release; потом скрипт запускает
`publish` в [tihonove/apt](https://github.com/tihonove/apt), и пакет появляется в apt.

## Разработка

```bash
npm test          # vitest: сервер, парсер
npm run test:go   # ttm-sync, включая fuzz-синк трёх машин
npm run typecheck
```

Node ≥ 24 запускает `.ts` напрямую, сборки нет. `ttm-sync` — на Go. Алгоритм слияния есть и там, и в
сервере; обе реализации сверяются по `packages/git/test/merge-corpus.json`.
