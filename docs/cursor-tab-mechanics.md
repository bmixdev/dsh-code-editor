# Механика Tab в Cursor и её перенос в `@local/dsh-ide`

Разбор собран статически по установленному Cursor 3.23.23. Ничего не запускалось
и не подключалось к аккаунту: все выводы — чтение кода бандла. Смещения ниже —
позиции символов в файле, а не байты; они верны для этой сборки и служат
навигацией, а не стабильным ABI.

- Цель: `C:\Users\bmix\AppData\Local\Programs\cursor\resources\app\out\vs\workbench\workbench.desktop.main.js` (39 262 104 символа).
- `out\main.js` (2 734 232 символа) не содержит `StreamCpp`/`CppConfig`: вся
  логика Tab живёт в рендерере, в основном бандле воркбенча.
- Вспомогательные выгрузки регионов: `C:\Temp\cursor-scan\dump.mjs` (санитайзер
  + смещения по строкам).

## 1. Протокол

Определения protobuf лежат около смещения 15 248 490–15 266 000.

`aiserver.v1.AiService/StreamCpp` — server streaming, рядом `CppConfig` (unary),
`CppAppend`, `CppEditHistoryStatus`, `RefreshTabContext`. Синхронизация файла
идёт отдельно: `aiserver.v1.FileSyncService/FSUploadFile`, `FSSyncFile`.
Отдельный сервис `CmdKService` — это inline-чат, не Tab.

`StreamCppRequest` (важнейшие поля): `current_file`, `diff_history`,
`model_name`, `linter_errors`, `context_items`, `parameter_hints`,
`lsp_suggested_items`, `lsp_contexts`, `filesync_updates`, `workspace_id`,
`control_token` (0 UNSPECIFIED, 1 QUIET, 2 LOUD, 3 OP), `client_time`,
`time_since_request_start`, `time_at_request_send`, `client_timezone_offset`,
`supports_cpt`, `supports_crlf_cpt`, `code_results`.

`StreamCppResponse`: `text`, `suggestion_start_line`,
`suggestion_confidence`, `done_stream`, отладочные поля (5–10),
`range_to_replace` (11), `cursor_prediction_target` (12), `done_edit` (13),
`model_info` (14) с `is_fused_cursor_prediction_model` и `is_multidiff_model`,
`begin_edit` (15), `should_remove_leading_eol` (16), `binding_id` (17).

Наблюдение: сервер отдаёт **диапазон для замены и текст**, а не только
продолжение строки. Это и есть источник «умного Tab»: модель может переписать
хвост строки или несколько строк ниже курсора, а клиент сравнивает и красит
изменённые слова.

## 2. Триггер и дебаунс

Сервис `pn("cppTypeService")` около смещения 38 400 000:

- `getStream({uri, editor, position, model, abortController, generationUUID,
  modelValue, modelVersion, context, source})` собирает запрос и передаёт
  `controlToken` из конфига;
- перед запросом `await this.debouncer.shouldDebounce(uuid)`; реализация
  `shouldDebounce` — смещение 15 844 038: история пар `{requestId, startTime}`,
  ожидание остатка `clientDebounceDuration`, затем проверка, что следующий
  запрос не пришёл слишком рано;
- обрыв потока вешает `signal.addEventListener("abort", () => cancelCpp(uuid))`,
  то есть каждый запрос отменяем на сервере;
- `CppConfigResponse` (смещение ~16 698 000) отдаёт `above_radius`,
  `below_radius`, `merge_behavior {type, limit, radius}`, `is_on`,
  `is_ghost_text`, `heuristics`, `exclude_recently_viewed_files_patterns`,
  `global_debounce_duration_millis`, `client_debounce_duration_millis`,
  `recently_rejected_edit_thresholds {soft, hard}`,
  `include_unchanged_lines`, `allows_tab_chunks`,
  `tab_context_refresh_debounce_ms`.

Вывод: задержка, радиус контекста и набор проверок — серверные настройки,
которые Cursor кеширует. В нашем плагине они стали локальными настройками
(`debounceMs`, `aboveLines`, `belowLines`, `heuristics*`).

## 3. Планирование правки на клиенте

`handleStreamOutput` (район 38 400 000+):

- диапазон ответа `range_to_replace` разворачивается в **целые строки**:
  `{startLineNumber, startColumn: 1, endLineNumberInclusive,
  endColumn: model.getLineMaxColumn(endLine)}`;
- текст собирается одним из трёх путей: `kNS` (fused cursor prediction),
  `SNS` (обычная однострочная сборка), `CNS` (multidiff: возвращает
  `{rewriteRange, text, bindingId}` и требует `should_remove_leading_eol`, иначе
  бросает `Multidiff edits always should have set shouldRemoveLeadingEol.`);
- нормализация переводов строк: если диапазон начинается в `1:1` и текст
  начинается с EOL — EOL срезается; если в буфере CRLF и текст кончается `\r` —
  `\r` снимается;
- `nextAction` (после принятия) ведёт либо в `fusedCursorPrediction`
  (кросс-файл), либо в `nextEdit`;
- перед показом: `lastStartedRequestId !== requestId` → в кеш, а не на экран;
  `getCurrentSuggestion() !== undefined` → не перебивать видимую подсказку;
  `modelVersion` изменился → в кеш; тот же `modelVersion` — показывать.

## 4. «Пустая» подсказка

`Ega(model, range, suggestion, eol)` (смещение 38 359 687) — детектор no-op:

1. приводит переводы строк предложения к EOL документа;
2. считает завершающие пустые строки у обеих сторон (`Tga`);
3. заменяет завершающие переводы строк в предложении на `eol.repeat(blanks+1)`;
4. отдельный случай для последней строки ячейки notebook;
5. если у предложения на одну завершающую пустую строку больше — последняя
   строка отбрасывается;
6. сравнивает строки **с конца**; `isNoOp`, если совпали все строки обеих сторон.

`createUnseenSuggestion` (38 363 971) вызывает `Ega` и при no-op вообще не
создаёт подсказку. Мы перенесли это в `isNoOp` (`tab.js`) и применяем дважды:
чтобы подавить бессмысленный ответ и чтобы понять, что план пуст.

## 5. Проверки «плохих случаев»

`pn("cppBadHeuristics")` (38 361 071), `isValidCppCase({model, modelOutputText,
startingRange, notebookInfo, eol})` возвращает `{valid, isInvalidBecauseNoOp,
modelOutputText}`:

| Проверка | Условие отказа |
| --- | --- |
| размер файла | `model.getValueLength() >= 1e6` — проверки **не** применяются, ответ принимается как есть |
| no-op | `Ega(...).isNoOp` → `isInvalidBecauseNoOp: true` (клиент может показать только предсказание курсора) |
| только пробелы | `!cppShowWhitespaceOnlyChanges` и все добавленные/удалённые куски после `trim()` пусты |
| `DUPLICATING_LINE_AFTER_SUGGESTION` | в ответе ≥2 строк, последняя непустая и равна строке сразу после диапазона, и это не `}`/`]` |
| `REVERTING_USER_CHANGE` | кандидат совпадает с недавним состоянием документа (`IsRevertingToRecentModel`) |
| `OUTPUT_EXTENDS_BEYOND_RANGE_AND_IS_REPEATED` | каждая строка ответа равна соответствующей строке исходника от начала диапазона |
| `SUGGESTING_RECENTLY_REJECTED_EDIT` | кандидат попадает в пороги `softRejectThreshold`/`hardRejectThreshold` |
| `LOTS_OF_ADDED_TEXT` | объявлен в enum `G_t`, но в этой ветке не проверяется — вероятно, обрабатывается на сервере |

Перечисление `G_t`: 0 UNSPECIFIED, 1 LOTS_OF_ADDED_TEXT, 2
DUPLICATING_LINE_AFTER_SUGGESTION, 3 DUPLICATING_MULTIPLE_LINES_AFTER_SUGGESTION,
4 REVERTING_USER_CHANGE, 5 OUTPUT_EXTENDS_BEYOND_RANGE_AND_IS_REPEATED,
6 SUGGESTING_RECENTLY_REJECTED_EDIT.

## 6. Показ и принятие

- `displayCppSuggestion` (38 378 700 / 38 406 474) не показывает подсказку, если
  уже видна другая; `saveCurrentTextIntoSuggestion` перечитывает текст диапазона
  перед применением — защита от дрейфа буфера.
- Контекстный ключ `shouldAcceptTabContextKey` берётся из фактической привязки
  `Tab` (`Yxe`), а не из предположения: если пользователь переназначил Tab,
  подсказка не перехватывает клавишу.
- `acceptSuggestion(onlyAcceptFirstWord, …)` возвращает
  `{type: pO.NotAccepted | AcceptedWord | AcceptedAll}`; `pO` = `AcceptedWord=0,
  NotAccepted=1, AcceptedAll=2`. Условия отказа: нет редактора/модели, фокус не в
  тексте (разрешены `searchView`/`problemsView`), нет курсора.
- `makeChangesOnAcceptCppSuggestion` считает `wordDiff` между исходным текстом и
  заменой, применяет правку и обновляет зелёные подсветки; при приёме слова
  (`makeEditsForNextWordAccept`) подсказка остаётся видимой, помечается
  `suggestionIsCurrentlyHidden: true, hasBeenSeen: true`.
- `cleanupAfterAcceptSuggestion`: отменяет все запросы того же `requestId`,
  сбрасывает счётчик «очищенных» подсказок, скрывает ghost, логирует событие и
  запускает следующее действие (`nextActionId`): `fusedCursorPrediction` или
  `nextEdit`.
- `revertSuggestion(editor, {removeGreens})` откатывает принятое.

## 7. Что перенесено, а что нет

Перенесено (Host, `tab.js` + `index.js`):

| Cursor | У нас |
| --- | --- |
| `Ega` (no-op) | `isNoOp` |
| `range_to_replace` + нормализация EOL | `planEdit`: эхо-срез, вставка, замена хвоста/строк |
| `isValidCppCase` | `evaluateSuggestion` (`empty`, `no-op`, `whitespace-only`, `duplicate-line`, `extends-range`, `too-many-lines`, `recently-rejected`, `reverting-change`) |
| `shouldDebounce` | `scheduleGhost` + `debounceMs` |
| `shouldAcceptTabContextKey` | `dshIdeGhostVisible` (наша подсказка не перехватывает Tab без неё) |
| `pO` (слово/целиком) | `acceptWord` (`Ctrl+→`), `acceptGhost` (`Tab`) |
| `recentlyRejected` пороги | `rejections` в памяти клиента + `recentRejectThreshold`/`recentRejectWindowMs` |
| `IsRevertingToRecentModel` | `revertions`: клиент шлёт удалённые фрагменты |
| `CppConfigResponse`-настройки | 20 ключей в `prefs.js` и два раздела настроек |

Не перенесено и почему:

- нет серверного `/StreamCpp`: один ответ модели, поэтому `range_to_replace`
  вычисляется локально из ответа, а не приходит с сервера;
- нет потоковой сборки посимвольно (`SNS`/`kNS`/`FWp`) — ответ приходит целиком,
  стабильность даёт проверка версии модели и текста диапазона;
- нет `diff_history`, `filesync_updates`, `lsp_*`, `parameter_hints` — плагин
  видит один буфер и не имеет LSP;
- нет `nextEdit`/`fusedCursorPrediction` — после приёма просто запрашивается
  продолжение (`refetchAfterAccept`);
- нет зелёных подсветок изменённых слов: удаляемый хвост красится одной
  декорацией (`showRemovedDecorations`), вставка — ghost-текстом;
- нет `CppAppend`, статистики принятия и телеметрии.

## 8. Границы и что осталось неизвестным

- `LOTS_OF_ADDED_TEXT` в клиентской ветке не проверяется: неизвестно, есть ли
  проверка на сервере — у нас она реализована как `maxAddedLines`.
- Порядок показа `begin_edit`/`done_edit` (мультидиапазонные правки) разобран
  только по полям протокола; поведение на нескольких диапазонах не проверялось.
- Диапазоны смещений — по конкретной сборке 3.23.23; после обновления Cursor
  их нужно искать заново (`dump.mjs` и `find.mjs` из `C:\Temp\cursor-scan`).
- Всё это статическое чтение: утверждения о поведении сервера Cursor —
  вывод из полей и вызовов, а не наблюдение.

## 9. Как это настраивается

Все ключи лежат в `~/.dsh/code-editor.json` и доступны на странице настроек
(`Ctrl+,`): «Подсказки ИИ» — задержка, окна контекста, длина ответа, размер
файла, пауза после Esc, замена хвоста, приём по слову, повторный запрос,
комментарии, подсветка, причины; «Проверки подсказок» — пробельные правки, рост
ответа, память отказов, дубль строки, повтор диапазона, отмена правки. Причины
отказа видны в панели «Траектория» (`explainSuppressed`).
