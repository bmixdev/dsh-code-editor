# HANDOVER — Cursor + внешние модели (после переноса из `rea`)

Дата: 2026-11-11. Проект: `C:\Users\bmix\Documents\project\cursor_other_llm`.
Перенесено из `C:\Users\bmix\Documents\project\rea` (там остались только материалы
по Notepad 11). Ниже — состояние, доказательства, как продолжать и границы.

## 1. Что сделано

1. Проведён REA-анализ установленного Cursor **3.23.23**
   (`C:\Users\bmix\AppData\Local\Programs\cursor`):
   * аутентификация: renderer-owned OAuth (`loginDeepControl` + PKCE-подобный
     challenge + poll `/auth/poll` + deep link `cursor://cursorAuth`), токены
     `cursorAuth/accessToken|refreshToken` в `state.vscdb`, refresh через
     `POST /oauth/token`, JWT без проверки подписи на клиенте; `cursorCreds` и
     RPC в extension hosts; entitlement/квоты — только сервер Cursor;
   * инференс retail: `AgentClientService.run` → connectrpc
     `aiserver.v1.AiService/StreamComposer` → `api2.cursor.sh` с `x-cursor-auth`;
   * найдена штатная, но выключенная ветка **local mode**: локальный агентский цикл
     в extension host и прямой HTTP в OpenAI/Anthropic-совместимый endpoint;
     гейт — `localMode:!1` в `out/main.js` и двух workbench-бандлах;
   * проверены целостность (только advisory-предупреждение), подпись exe, обновления
     (полный Inno-инсталлятор стирает патч), ToS-границы.
2. Собран рабочий комплект `tools/cursor-local-gateway/`:
   * `gateway.py` **1.2.0** — локальный OpenAI-совместимый шлюз (`/v1/models`,
     `/v1/chat/completions` SSE, `/v1/responses`), пресеты провайдеров
     `openrouter` / `opencode-go` / `custom`, `--selftest`;
   * `patch_cursor.py` — check/apply/restore патча c1/c2, SHA-256-проверка pristine,
     бэкап, атомарная запись;
   * `cursor-local.bat` — единый launcher: меню, мастер провайдера/ключа,
     автопатч, запуск шлюза с ожиданием `/healthz`, отсоединённый запуск Cursor;
   * вспомогательные: `start-gateway.bat`, `run-cursor.bat`, ps1-скрипты,
     `model_map.example.json`, `gateway.env.example.bat`, README.
3. Проверено live (2026-11-11):
   * c1-патч применён к установке (бэкап:
     `C:\Users\bmix\AppData\Local\cursor-patch-backup\3.23.23`);
   * шлюз на `127.0.0.1:8787` с OpenRouter-ключом: `/v1/models` 433 модели;
   * IDE-чат Cursor → `POST /v1/chat/completions` (stream, 200):
     `x-ai/grok-4.7` → «gateway-ok», затем `deepseek/deepseek-v4.1-flash-1017` →
     ответ модели; в логе Cursor `[local-agent][config] path=agent ... resolved`;
   * прямой тест DeepSeek V4.1 Flash через шлюз: non-stream/stream 200,
     `deepseek-ok`, usage/cost в ответе;
   * OpenCode Go: endpoint `https://opencode.ai/inference/go/v1/models` публично
     отдаёт 200, с фейковым ключом — 401; пресет шлюза проверен автотестом
     (passthrough плоских id, `x-opencode-session`, `User-Agent`, extra headers).

## 2. Текущее состояние машины на момент переноса

* Cursor 3.23.23: **пропатчен** (`c1`), запускается через лаунчер с
  `--disable-updates`; при старте показывает ожидаемое предупреждение
  «Installation has been modified on disk» (это advisory checksum, не ошибка).
* Шлюз: путь `tools\cursor-local-gateway`, порт `8787`, `gateway.py` 1.2.0.
  Конфиг — `tools\cursor-local-gateway\gateway.env.bat` (git-ignored). Сейчас
  настроен **OpenCode Go**: `PROVIDER=opencode-go`, endpoint
  `https://opencode.ai/inference/go/openai/v1`, модели — каталог Go, модель по
  умолчанию `deepseek-v4.1-flash`, ключ подписки присутствует локально.
  Лог запросов — `tools\cursor-local-gateway\requests.jsonl`.
  Проверено live: `/v1/models` → 30 моделей Go; `POST /v1/chat/completions`
  (`deepseek-v4.1-flash`) → HTTP 200, ответ `opencode-ok`; запись есть в
  `requests.jsonl`. Ранее шлюз также проверялся live на OpenRouter
  (`x-ai/grok-4.7`, `deepseek/deepseek-v4.1-flash-1017`).
* `git` в новом проекте инициализирован; `analysis/` и конфиг с ключом — в
  `.gitignore`.
* Сессия DSH (эта беседа): id `session-c75dafdf-9909-41fd-abf7-8a7a6d65d9c9`,
  исходный воркспейс `C:\Users\bmix\Documents\project\rea`.
  * снимок транскрипта: `analysis/cursor/session/session-c75dafdf-...v4.jsonl.zstd`
    (git-ignored, содержит историю беседы — не публиковать);
  * копия для нового воркспейса:
    `%USERPROFILE%\.dsh\sessions\--C-Users-bmix-Documents-project-cursor_other_llm--\session-c75dafdf-...\session.v4.jsonl.zstd`;
  * в `%USERPROFILE%\.dsh\storages\workspace.json` добавлен воркспейс
    `1abfa2ec-971f-437e-8f1b-35fb4e89d991` → путь этого проекта, с этой сессией
    (бэкап реестра: `workspace.json.bak-20261111T133207`). Если DSH перезапишет
    реестр при завершении текущей сессии — сессия просто не появится в списке,
    на работу это не влияет: контекст в HANDOVER и снимке.

## 3. Как продолжать в новой сессии

1. Открыть DSH в этом проекте (`C:\Users\bmix\Documents\project\cursor_other_llm`).
2. Прочитать `README.md`, этот файл и при необходимости
   `docs/rea-analysis/cursor-3.23.23/cursor-auth-external-models.md`.
3. Проверить состояние: `tools\cursor-local-gateway\cursor-local.bat status`.
4. Запуск: `cursor-local.bat` → `1` (или `cursor-local.bat start`). Провайдера и
   ключ менять через пункт `4`; для OpenCode Go — ключ из
   https://opencode.ai/console (подписка Go).
5. Работать с внешними моделями только в **IDE-чате / Local target**; режим Cloud
   в агентском окне выполняет запрос на серверах Cursor и внешние id моделей не
   принимает (`BAD_MODEL_NAME` / «Model Not Available»).

## 4. Что осталось / следующие шаги

* ~~Пополнить баланс OpenCode Go~~ — **снято 20.11.2026 в 18:34**: запрос
  `deepseek-v4.1-flash` через шлюз вернул 200 (`billing_source: go`,
  `list_cost 0.00000705`). 402 из §7 больше не воспроизводится. Осталось
  факультативно: `MODELS_ALLOWLIST`, чтобы не показывать сотни моделей в пикере.
* При желании — валидировать c2-вариант патча (узкий, только workbench) на копии
  установки; c1 уже проверен live.
* Уточнить offsets для glass-UI, если Cursor обновится (патч привязан к 3.23.23 по
  SHA-256; после апдейта нужен новый анализ/патч).
* Автотесты: `python gateway.py --selftest`, `python patch_cursor.py --selftest`.
* Не забыть: `cursor-local.bat start` запускает Cursor detached; обновления Cursor
  отключены флагом, но ручной инсталлятор всё равно перезапишет патч.
* Плагин `plugins/dsh-code-editor/` закоммичен (`df1a0fa`), но **визуально в GUI
  не проверен**: браузер DSH не отдаёт CDP, поэтому автопроверка вкладки
  невозможна. Нужна ручная проверка в `http://127.0.0.1:60243`: открыть файл в
  правой панели → кнопка «Редактировать» → вкладка редактора.
* **Перезапустить DSH** и только потом верить замеру. Вкладка редактора в GUI
  проверена (открывается, Monaco рисуется, согласие выдаётся, «Замер» работает),
  но сервер GUI — процесс от `14:02:50`, а Host-половина плагина правилась после
  (`16:5x` и `18:5x`), поэтому живой Host работает на старом коде. Признак: замер
  дал `непустых вставок 0` из 100, потому что старый Host игнорировал `text` и
  собирал промпт из отсутствующих `prefix`/`suffix` — то есть из пустоты.
* Завершить интеграцию Continue (§8). Шаг 2 плана выполнен: клиентская половина
  отправляет `text`/`offset`/`selection` и запрошенное окно, окна вырезает
  `buildContext` в Host, бюджет зажимает `boundedWindow`. Остались шаги 3-5 плана
  `plans/continue-integration.md`: переключатель базового и экспериментального
  режимов, прогон без сети (шаг 3), замер пользы (шаг 4: ≥100 запросов на режим,
  p50 ≤ 500 мс, p95 ≤ 1,5 с), поставка и откат (шаг 5).

## 5. Границы

* Аутентификация Cursor **не обходится**: вход в аккаунт обязателен, токены и
  entitlement не трогаются; подмена backend/логина не реализуется.
* Модификация клиента (патч) — серая зона ToS Cursor (п. 1.5(i)/(ii)); только своя
  установка и свои ключи провайдеров.
* Шлюз слушает только `127.0.0.1`; не публиковать.

## 6. Карта доказательств

| Артефакт | Путь |
|---|---|
| Итоговый отчёт | `docs/rea-analysis/cursor-3.23.23/cursor-auth-external-models.md` |
| Аутентификация | `docs/rea-analysis/cursor-3.23.23/findings-auth.md` |
| Инференс и provider-config | `docs/rea-analysis/cursor-3.23.23/findings-inference.md` |
| Целостность/патч/ToS | `docs/rea-analysis/cursor-3.23.23/findings-modernization.md` |
| PoC и patch-sites | `docs/rea-analysis/cursor-3.23.23/poc/`, `analysis/cursor/poc/` |
| Скан бандлов | `analysis/cursor/scan.jsonl`, `scan-summary.txt` |
| Скрипты | `analysis/cursor/verify.py`, `q.py`, `probe.py`, `scan_bundle.py` |
| UI-подтверждения | `analysis/cursor/ui/*.png` |
| Снимок сессии | `analysis/cursor/session/session-c75dafdf-...v4.jsonl.zstd` |
| Лог шлюза | `tools/cursor-local-gateway/requests.jsonl` (git-ignored) |

## 7. Проверка 20.11.2026

Проведена в сессии DSH `session-98eeec4b-7b55-4ea8-8084-5ee905e27915`.

* Шлюз поднят, `/healthz` → `200 {"status": "ok", "version": "1.2.0"}`.
* Все запросы к апстриму OpenCode Go → **402**:
  `{"error":{"type":"invalid_request_error","message":"Insufficient balance. Top up at
  https://opencode.ai/console/org_01M723WQ627X20RD2H6270BQ03/billing?credits=1."}}`
  Проверены `deepseek-v4.1-flash`, `grok-4.7`, `deepseek-v4-pro` — ответ одинаковый,
  stream и non-stream тоже. В `requests.jsonl` это `status: 402, error: upstream_http`.
  Причина — баланс аккаунта, не шлюз и не патч.
* `gateway.py --selftest` → `SELFTEST PASSED` (models/chat/stream/responses/opencode-go-заголовки).
* `patch_cursor.py --selftest` → `SELFTEST PASSED`; `--check` → `3.23.23`, все три
  бандла `patched`, c2-sites `5/5`.
* Плагин `plugins/dsh-code-editor/`: `node --test tests/host-smoke.mjs` → 6 pass, 0 fail.
  Кириллица в `client.js` и `locale/ru.json` — корректный UTF-8 (в терминале
  PowerShell отображается как mojibake; файлы в порядке).
* Плагин закоммичен вместе с `plans/` в `df1a0fa`; `git status` чистый.
* Визуальная проверка плагина в GUI **не выполнена**: браузер DSH на
  `http://127.0.0.1:60243` не открывает CDP-порт (9222/9223/9333 закрыты), поэтому
  осмотреть вкладку автоматически нельзя. Нужна ручная проверка.

## 8. Интеграция Continue (20.11.2026)

Перенесены только операции без I/O — подготовка `prefix/suffix` и очистка ответа.

* Источник: Continue, commit `5522c6f44ca0ac3528b37244818fbfa39b5af470`
  (21.07.2026). Лицензия проверена по `LICENSE` этого коммита: «Apache License,
  Version 2.0», «Copyright 2023 Continue Dev, Inc.». Уведомление и перечень
  изменений — в шапке `plugins/dsh-code-editor/completion.js`.
* Новые файлы: `plugins/dsh-code-editor/completion.js` (операции без I/O) и
  `plugins/dsh-code-editor/tests/completion.test.mjs` (15 тестов).
* Изменены: `plugins/dsh-code-editor/index.js` (импорт, `TOP_LEVEL_KEYWORDS`,
  `complete` вызывает `buildContext` и `postprocessCompletion`, `sanitizeCompletion`
  больше не снимает забор кода) и `plugins/dsh-code-editor/tests/host-smoke.mjs`
  (настраиваемый ответ модели + два новых теста).
* Прогон: `node --test tests/completion.test.mjs tests/host-smoke.mjs` →
  **24 теста, 24 проходят, 0 падений**.
* Перенесено: `lineIsRepeated` со своим Levenshtein, `stopAtLines`, `skipPrefixes`,
  `skipLines`, `removeTrailingWhitespace`, `filterLeadingNewline`, `avoidPathLine`,
  `noTopLevelKeywordsMidline`, `stopAtRepeatingLines`, `validatePatternInLine`,
  `rewritesLineAbove`, `isExtremeRepetition`, `removeBackticks`, дедупликация
  пробела, форма `constructInitialPrefixSuffix`.
* Не перенесено: блок `llm.model.includes(...)` (костыли под конкретные модели),
  `lineFilters`/`charFilters`, кэш Continue, diff-движок.
* Два бага найдены при подключении и исправлены: `rewritesLineAbove` брал
  `split('\n').pop()`, что для префикса с завершающим переводом строки давало `""`
  (фильтр не срабатывал в самой частой позиции — в конце строки); и проверка
  выполнялась после снятия забора кода, поэтому видела уже очищенный ответ.
* Осознанные расхождения с Continue: короткие повторяющиеся строки (`}` ×4)
  схлопываются в одну; ключевое слово внутри более длинного идентификатора
  (`const myfunction = 1`) обрывает строку, потому что порт ищет `keyword + ' '`.
* Шаг 2 плана (20.11.2026): `client.js` больше не режет окна сам и отправляет
  `{ text, offset, selection, contextLeft, contextRight }` — окна вырезает
  `buildContext` в Host. Бюджет не является доверенным вводом: `boundedWindow`
  зажимает запрошенное окно к `CONTEXT_LEFT = 4000` / `CONTEXT_RIGHT = 1000`, а
  `open`/`settings` возвращают `context: { left, right }`, чтобы текст согласия
  показывал реальный бюджет. Буфер ограничен `MAX_CONTEXT_TEXT_CHARS` (4 МиБ) —
  превышение отклоняется кодом `context-too-large` до вызова модели.
* Базовая линия задержки берётся не из живого буфера в момент запроса (пауза
  `COMPLETION_PAUSE_MS = 200` уже добавила бы туда нажатия и ожидание засчиталось
  бы модели), а из `committedText`/`committedOffset`, снятых при изменении буфера
  сразу после показа предыдущей вставки; живые значения используются, если
  буфера не было, он устарел (>30 с) или совпал с живым.
* Третий баг найден при подключении: фоллбэк для клиента со старым протоколом
  (`prefix`/`suffix`) резал окна по `CONTEXT_LEFT`/`CONTEXT_RIGHT`, игнорируя
  запрошенное клиентом окно; теперь `clip(...)` получает уже вычисленные
  `left`/`right`. Также `MAX_CONTEXT_TEXT_CHARS` был объявлен дважды (вторая копия
  ниже по файлу), из-за чего проверка на размер буфера не срабатывала — дубль
  удалён.
* Ловушки тестов, стоившие времени: `offset - 30` попадает внутрь `m`-прогона,
  поэтому узкое окно законно не содержит ни одной `a`; `String.prototype.includes`
  с длинной иглой (4000 символов) по длинной строке возвращает `false`, тогда как
  `indexOf` находит вхождение — длинные иглы не годятся для якорных проверок;
  ответ Host — `{ error: { code, message } }`, а не `{ code }`.
* Четвёртый баг — **порядок заголовков в промпте** (найден 20.11.2026 по замеру):
  суффикс подставлялся в блок «--- курсор ---», а заголовок «--- текст после
  курсора ---» оставался последней строкой без содержимого. Модель видела текст,
  который идёт *после* курсора, как продолжение и на 100 запросах из 100 вернула
  пусто (`непустых вставок 0`). Исправлено: суффикс идёт после своего заголовка;
  порядок закреплён проверкой в `tests/host-smoke.mjs` (между «--- курсор ---» и
  «--- текст после курсора ---» ничего нет, суффикс — ниже второго заголовка).
* Числа первого замера (`p50 416 мс`, `p95 449 мс`, `max 593 мс`,
  `непустых вставок 0`) **не являются замером пользы**: сервер GUI поднят в
  14:02:50, то есть до правок Host-половины, и работал со старым кодом. Их можно
  использовать только как верхнюю границу накладных расходов клиента и шлюза.
* Клиентская половина при этом проверена живьём: строка замера содержит
  «непустых вставок», то есть в браузере загружен новый `client.js` (клиентские
  бандлы отдаются с диска и подхватываются перезагрузкой страницы, Host — нет).
* Продолжение строки-комментария (20.11.2026, вечер). Сценарий «написал
  комментарий — получил код призрачной подсказкой» был сломан дважды:
  `cleanLines` и `sanitizeCompletion` срезали ведущий перевод строки, поэтому код
  приклеивался к комментарию в той же строке, а в системном промпте про
  комментарий не было ни слова. Исправлено: промпт требует начинать ответ с
  перевода строки для комментария-просьбы; `postprocessCompletion` сохраняет этот
  перевод, а если модель ответила чистым кодом, а курсор стоит в конце
  комментария — добавляет перевод сам (`endsInComment` + `isCommentOnlyLine`,
  стили `#`, `//`, `--`, `;`, `*`, `/*`, `<!--`). Прогон —
  `node --test tests/completion.test.mjs tests/host-smoke.mjs` → **26 тестов, 26
  проходят**.
* `maxTokens` поднят с 160 до 400 по замеру, а не по вкусу: `deepseek-v4.1-flash`
  — рассуждающая модель, и на 160 токенах весь бюджет уходил в `reasoning_content`
  (`finish_reason: length`, `content: ""`). Даже 400 не всегда хватает: на одном
  промпте рассуждение заняло 1796 символов, и ответ снова пришёл пустым. Замер по
  живому провайдеру на комментарии-просьбе: `glm-5.3-flash` — 908 мс, без
  рассуждений, верный код; `claude-haiku-5-5` — 1749 мс, без рассуждений, верный
  код; `qwen3.8-flash` — 11,3 с и 2489 символов рассуждений. Вывод для строчных
  подсказок: нужна нерассуждающая модель; сейчас плагин берёт модель сессии, и её
  стоит вынести в настройку плагина.
* Честный запуск шлюза ломается о протухший `HTTPS_PROXY`. На машине остался
  `HTTPS_PROXY=http://127.0.0.1:18128` от уже убитого процесса: `urllib` идёт по
  нему и падает с `WinError 10061`, хотя `curl` на тот же URL отвечает, а прямой
  маршрут работает. В `gateway.py` добавлен `open_upstream()`: `GATEWAY_NO_PROXY=1`
  игнорирует переменные окружения, `GATEWAY_PROXY=http://…` задаёт прокси явно;
  без обеих переменных поведение прежнее. Проверено живьём: с
  `GATEWAY_NO_PROXY=1` `/healthz` отвечает `ok 1.2.0`, а завершение приходит
  HTTP 200.
* Подсказку можно вызвать принудительно: `Ctrl+Space` в редакторе. Это тот же
  запрос, что делает умный Tab, но без паузы `COMPLETION_PAUSE_MS`: ручной
  вызов приходит в тот же `provideInlineCompletions` с
  `triggerKind === 1` (`InlineCompletionTriggerKind.Explicit`), поэтому второго
  HTTP-пути нет и замеры идут в общий счётчик. Рисует подсказку сам Monaco
  (inline suggest): серые строки встают под курсором как продолжение — в том
  числе отдельной строкой ниже комментария, — `Tab` вставляет, `Esc` убирает.
  Свой призрачный текст в декорации для этого не годится: инъекция `after`
  однострочная, и многострочный ответ склеивался в одну строку с «⏎».
  Список предложений Monaco (классический suggest) тоже не подходит — он
  подмешивает слова из файла, и они читаются как «ответ модели не тот», поэтому
  в опциях редактора выставлен `wordBasedSuggestions: 'off'`.
* Почему «не работает» невозможно было отличить от «модель промолчала»: обе
  ситуации дают пустой ответ. Теперь каждая попытка пишет строку в
  `%TEMP%\dsh-code-editor-completion.log` (`rawChars` — что вернула модель,
  `answerChars` — что осталось после фильтров), а `config.completionModel` и
  `DSH_CODE_EDITOR_MODEL` задают модель подсказок отдельно от модели сессии,
  с откатом на модель сессии, если первая ответила пусто.
* Корень «модель промолчала за 7 мс»: сообщение уходило с `content` строкой, а
  адаптер DSH ждёт список типизированных блоков `[{type: 'text', text}]` — так
  вызывают `ctx.llm.stream` и `commentpilot/model.js`, и сам `dsh-agent-loop`
  (`createUserMessage({content: [{type: 'text', text}]})`). Со строкой поток
  заканчивался без единого чанка, поэтому пусто и мгновенно, без ошибки. Теперь
  `messages[0].content` — блок, тест `lastPrompt()` проверяет форму, и в лог
  пишутся `chunkTypes`, `finishReason`, `firstChunk`, `error`.
* Пустой ответ на рассуждающей модели остаётся отдельной причиной: у
  `deepseek-v4.1-flash` весь бюджет уходил в `reasoning_content`
  (`finish_reason: length`). Для подсказок нужна нерассуждающая модель —
  `glm-5.3-flash` дал 908 мс и готовый код против 7+ секунд и пустоты.

