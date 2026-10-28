# Тесты

```bash
npm test                                      # vitest run
npm run test:coverage                         # + храповик покрытия
claude-lease run -- npm run test:mutation     # Stryker по диффу против origin/main, под лизой
npm run test:mutation -- --scope-only         # только показать, что будет мутировано
npm run test:mutation -- --base <ref>         # другая база диффа
claude-lease run -- npm run test:mutation:full  # весь код (так гоняет ночной CI)
npm run typecheck
```

Перед сдачей фичи — все три: `typecheck`, `test:coverage`, `test:mutation`. Покрытие говорит «строка
исполнилась», мутационный балл — «кто-то её проверил»; одно без другого даёт ложное зелёное.
Подход тот же, что в diode (`~/workspace/diode/docs/MUTATION.md`), в уменьшенном виде.

## Покрытие

v8 через vitest, порог — **храповик**: `coverage.thresholds` с `autoUpdate: true` в
[`vitest.config.ts`](../vitest.config.ts). Покрытие упало ниже планки — прогон красный; выросло —
vitest сам поднимает числа, их коммитим. В CI храповик только проверяет (`autoUpdate=false`).

Исключаем из метрики только точки входа процессов — там argv, сигналы и `exit`, а вся логика
вынесена в модули рядом и покрыта напрямую:

| Файл | Почему |
|---|---|
| `packages/sync/src/cli.ts` | CLI демона |
| (`merge-driver` — подкоманда `cli.ts`) | процесс, который запускает git; логика — `driver.ts` |
| `apps/server/src/main.ts` | запуск сервера; логика — `server.ts` |
| `apps/mobile/App.tsx`, `apps/mobile/src/{api,settings,appUpdate}.ts` | экраны и обёртки над нативными модулями (keystore, expo-updates) — проверяются web-сборкой и на телефоне; логика — `model.ts` |

Новые исключения — только по этому же признаку. Код, который исполняет дочерний процесс, v8 не
видит: такую логику держим в модуле, который тест зовёт напрямую (как `runDriver`).

## Мутационное тестирование

[`stryker.config.json`](../stryker.config.json): vitest-раннер, `perTest`, порог `break: 100`.
Мутируется `src` кроме тех же точек входа.

**Скоуп — дифф** ([`scripts/mutation-diff.ts`](../scripts/mutation-diff.ts), как в diode): новые
файлы целиком, правленые — строками из хунков, где изменился код (хунки только из комментариев и
пустых строк не считаются). База — merge-base с `origin/main` или `--base`. Рабочее дерево
сравнивается с базой, так что незакоммиченное тоже в скоупе.

**Вердикт — гейт, а не код возврата Stryker'а**: инкрементальный прогон
(`reports/stryker-incremental.json`) дописывает в отчёт старые результаты вне `--mutate`. Гейт
читает `reports/mutation/mutation.json`, берёт только мутантов скоупа и красится, если балл ниже
`thresholds.break` или есть `Survived`/`NoCoverage`/`RuntimeError` (непроверенный мутант — не
проверенный). Итог — `reports/mutation/gate.md`, в CI он же — комментарий к PR.

| Где | Что |
|---|---|
| PR (`ci.yaml`, job `mutation`) | дифф PR против базовой ветки, комментарий в PR |
| ночью (`mutation.yaml`) | весь код (`test:mutation:full`) |

Выживший мутант — либо дыра (пишем тест на **поведение**), либо эквивалентный: поведение не
меняется никаким входом. Такой гасим комментарием с причиной, он выпадает из знаменателя:

```ts
// Stryker disable next-line EqualityOperator: при n === 0 обе ветки возвращают пустой список
```

Ассерт ради балла (проверка текста лога, сообщения об ошибке) — не ответ: он ломается при
переименовании и не ловит баги. Когда мутант не указывает на реальное поведение — `disable` с причиной.

Workspace-пакеты (`@ttm/git/*`) vitest резолвит в исходники рядом с конфигом, а не через
симлинки `node_modules`: в песочнице Stryker'а симлинки вели бы в оригинальные, немутированные файлы,
и мутанты `packages/git` «выживали» бы в тестах других пакетов.

Отчёт — `reports/mutation/mutation.html`. Прогон тяжёлый (тесты гоняют настоящий git) — только под
`claude-lease`.
