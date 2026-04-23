# TeleAgent Fork Documentation

Документация описывает, чем этот репозиторий отличается от upstream
[Ajaxy/telegram-tt](https://github.com/Ajaxy/telegram-tt), и где искать основные
точки расширения. Она предназначена для людей и LLM-агентов, которые будут
продолжать работу над форком.

## Кратко

TeleAgent - это форк Telegram Web A, сфокусированный на AI-ассистенте в правой
боковой панели. Базовая точка форка в этой рабочей истории:

- upstream/base: `e5da72b5e` (`origin/master`, `[Build]`)
- текущая локальная вершина: `4acf2f144`
- версия форка: `0.1.0`
- npm package name: `teleagent`

Главное отличие от исходного проекта: поверх Telegram Web A добавлен MVP
TeleAgent AI, который умеет работать с текущим состоянием клиента, искать
диалоги и сообщения, читать контекст и отвечать через OpenAI-compatible
провайдера с tool calling.

План развития агентного поведения описан отдельно:
[`docs/TELEAGENT_AGENT_ROADMAP.md`](TELEAGENT_AGENT_ROADMAP.md).

## История Изменений После Форка

Локальные коммиты поверх `origin/master`:

- `b20c23e7e` - начальная интеграция TeleAgent AI: настройки, базовая правая
  панель, OpenAI-compatible клиент, первые типы и состояние.
- `1a535f271` - первая рабочая версия: agent runtime с tool calling,
  инструменты для диалогов/сообщений, запуск из UI.
- `257af4b01` - улучшен UI активности ассистента: текущая фаза, шаги,
  отображение прогресса и ошибок.
- `acb291685` - добавлены tools для текущего диалога, папок и непрочитанного.
- `3a1925f09` - добавлена персистентность AI-чатов в глобальный cache.
- `8cafe665f` - сохранение промежуточного состояния.
- `836e4788a` - заменены логотипы, favicon, manifest/icon assets.
- `2c8bd6cc0` - добавлен onboarding-рекомендация подписаться на официальный
  канал `@teleagent_app`.
- `4364d1591` - добавлена валидация настроек TeleAgent AI.
- `adab637cf` - текстовые обновления.
- `4acf2f144` - Tauri сборка переведена на локально собранный frontend из
  `dist`.

## Новые Возможности

### TeleAgent AI Sidebar

Панель открывается из кнопки `ai` в шапке диалога и занимает правую колонку
вместо профиля/статистики/управления чатом.

Ключевые файлы:

- `src/components/right/TeleAgentAi.tsx` - основной UI AI-панели.
- `src/components/right/TeleAgentAi.module.scss` - стили панели.
- `src/components/middle/HeaderActions.tsx` - кнопка открытия TeleAgent AI.
- `src/components/right/RightColumn.tsx` - подключение нового контента правой
  колонки.
- `src/components/right/RightHeader.tsx` - заголовок `TeleAgent`.
- `src/global/actions/ui/misc.ts` - `toggleTeleAgentAi`,
  `setTeleAgentAiActivityExpanded`, `setTeleAgentAiLastActivityVisible`.
- `src/global/selectors/ui.ts` - выбор `RightColumnContent.TeleAgentAi`.

### Настройки AI

В настройки добавлен экран TeleAgent AI:

- enable/disable AI;
- API Base URL;
- API Key;
- Model;
- System Prompt.

Ключевые файлы:

- `src/components/left/settings/SettingsTeleAgentAi.tsx`
- `src/components/left/settings/Settings.tsx`
- `src/components/left/settings/SettingsMain.tsx`
- `src/components/left/settings/SettingsHeader.tsx`
- `src/global/selectors/settings.ts`
- `src/global/initialState.ts`
- `src/assets/localization/fallback.strings`

Провайдер должен поддерживать OpenAI-compatible endpoint
`POST {API Base URL}/chat/completions`. Для текущего agent runtime нужен tool
calling в формате, совместимом с OpenAI Chat Completions.

### Agent Runtime

Главный runtime находится в `src/lib/teleagent/agentRuntime.ts`.

Поток выполнения:

1. `sendTeleAgentAiMessage` добавляет сообщение пользователя в историю.
2. Настройки читаются через `selectTeleAgentAiSettings`.
3. `validateConfig` проверяет включенность AI, base URL, API key и model.
4. `runTeleAgentAgentRuntime` собирает system prompt, историю сообщений и
   schemas tools.
5. Модель получает `tools` и может вызывать функции.
6. Каждый tool call выполняется локально в браузерном клиенте, через текущее
   состояние Telegram Web A и `callApi`.
7. Результаты tools возвращаются модели как `role: "tool"`.
8. Цикл продолжается до финального ответа или до лимита `MAX_TOOL_ITERATIONS`.
9. Финальный ответ сохраняется в AI-историю и отображается в панели.

Ограничения runtime:

- максимум 15 tool-итераций на запрос;
- tool result режется до 12000 символов;
- данные берутся только из доступного клиентского состояния и Telegram API;
- ассистент не должен выдумывать недоступные сообщения, участников или
  действия;
- если пользователь говорит "текущий чат", runtime должен сначала вызвать
  `get_current_dialog`.

Есть также старый простой клиент
`src/lib/teleagent/openaiCompatibleClient.ts`. Он отправляет обычный
OpenAI-compatible запрос без tools и сейчас не является главным AI-путем.

### Tools Для Модели

Все tools объявлены в `src/lib/teleagent/tools.ts`.

Текущий набор:

- `get_current_dialog` - компактная информация о текущем открытом диалоге.
- `list_folders` - список папок диалогов.
- `list_dialogs_in_folder` - страница диалогов в папке.
- `list_dialogs` - страница последних диалогов.
- `search_dialogs` - поиск известных диалогов по названию/usernames/локальной
  metadata.
- `get_dialog_meta` - metadata одного диалога, включая доступный summary
  участников.
- `read_dialog` - чтение страницы сообщений диалога, с датами и cursor paging.
- `search_messages` - глобальный или scoped поиск сообщений.
- `get_unread_dialogs` - непрочитанные диалоги с scope `people`, `bots`,
  `groups`, `channels`, `all`.
- `get_unread_messages` - непрочитанные сообщения в одном диалоге или по scope.
- `get_message_context` - окно сообщений вокруг целевого messageId.

Важные детали:

- limits зажаты до 20 элементов на страницу;
- cursors сериализуются как opaque JSON strings;
- для непрочитанного дефолтный scope - `people`;
- tools синхронизируют новые чаты/сообщения обратно в global state через
  reducers (`updateChats`, `addMessages`, `addChatMessagesById` и др.);
- поиск диалогов содержит fuzzy/compact matching, чтобы модель могла находить
  чат по неполному названию.

### Activity UI

Пока модель работает, пользователь видит текущую активность:

- headline текущей фазы;
- количество выполненных шагов;
- раскрываемый список шагов;
- ошибки выполнения tools/runtime;
- архив последней завершенной activity рядом с последним ответом.

Ключевые файлы:

- `src/lib/teleagent/activity.ts`
- `src/global/actions/api/teleAgentAi.ts`
- `src/components/right/TeleAgentAi.tsx`

Модель может вернуть короткий тег `<phase_comment>...</phase_comment>`.
Runtime вырезает тег из финального текста и показывает его только как live UI
comment, если он проходит валидацию.

### История AI-Чатов

AI-чаты сохраняются отдельно от обычных Telegram сообщений:

- типы: `TeleAgentAiMessage`, `TeleAgentAiPersistedMessage`,
  `TeleAgentAiPersistedChat`, `TeleAgentAiHistory`;
- глобальное состояние: `global.teleAgentAiHistory`;
- tab runtime state: `tabState.teleAgentAi`;
- cache persistence: `src/global/cache.ts`.

`teleAgentAiHistory` хранит:

- `activeChatId`;
- `chatIds` в порядке последних обновлений;
- `byId` с persisted chat objects.

При старте нового AI-чата title берется из первого сообщения пользователя и
обрезается до 40 символов.

### Channel Onboarding

Добавлен однократный flow, который рекомендует официальный канал
`@teleagent_app`.

Ключевые файлы:

- `src/config/channelOnboarding.ts`
- `src/global/actions/api/channelOnboarding.ts`
- `src/global/actions/ui/channelOnboarding.ts`
- `src/components/modals/channelOnboarding/ChannelOnboardingModal.tsx`
- `src/components/modals/ModalContainer.tsx`
- `src/components/left/main/LeftSideMenuItems.tsx`

Flow запускается только в master tab после готовности UI, авторизации,
connection ready и sync. Если пользователь уже участник канала или проверка не
удалась, onboarding завершается silently. Результат хранится в settings key
`channelOnboarding.hasCompleted`, если не включен debug flag.

### Брендинг И Десктоп

Форк переименован и перебрендирован:

- `APP_NAME` и Tauri title теперь `TeleAgent`;
- package name/version: `teleagent@0.1.0`;
- обновлены favicon, webmanifest, public icons, Tauri icons;
- добавлены исходники в `new_logo/`;
- тексты metadata в `src/index.html` описывают TeleAgent.

Tauri сборка теперь использует локально собранный frontend:

- `tauri/tauri.conf.json`: `beforeBuildCommand = "npm run build:production"`,
  `frontendDist = "../dist"`;
- `deploy/prepareTauriConfig.js`: `frontendDist = "../dist"`;
- `tauri/src/lib.rs`: окна открываются через `WebviewUrl::App`, а URL
  нормализуются в app-relative path.

## Состояние И Типы

Основные измененные типы:

- `src/types/index.ts`:
  - settings keys `teleAgentAiEnabled`, `teleAgentAiApiBaseUrl`,
    `teleAgentAiApiKey`, `teleAgentAiModel`, `teleAgentAiSystemPrompt`;
  - TeleAgent AI message/history/activity/error types;
  - `SettingsScreens.TeleAgentAi`;
  - `RightColumnContent.TeleAgentAi`.
- `src/global/types/tabState.ts`:
  - `tabState.teleAgentAi`;
  - `channelOnboardingModal`.
- `src/global/types/globalState.ts`:
  - `teleAgentAiHistory`.
- `src/global/types/actions.ts`:
  - TeleAgent AI actions;
  - channel onboarding actions.

## Как Разрабатывать Дальше

Практические правила для людей и LLM:

- Сначала смотрите `src/lib/teleagent/agentRuntime.ts` и
  `src/lib/teleagent/tools.ts`, если задача про поведение ассистента.
- UI панели меняйте в `src/components/right/TeleAgentAi.tsx` и module SCSS.
- Настройки AI меняйте через settings state, а не через отдельный localStorage.
- Новые Telegram capabilities лучше добавлять как новые tools с маленькими,
  явно описанными schemas.
- Tool results должны быть компактными: возвращайте ids, titles, timestamps и
  short text previews, а не большие raw objects.
- Если tool загружает данные через `callApi`, синхронизируйте результат обратно
  в global state существующими reducers.
- Не смешивайте AI-chat history с Telegram message storage.
- Для правой колонки поддерживайте взаимное закрытие TeleAgent AI, chat info,
  management и statistics, как уже сделано в `misc.ts`.
- Onboarding канала держите независимым от AI runtime.
- При изменении Tauri URL-логики проверяйте и dev mode, и production build:
  desktop теперь ожидает локальный bundled frontend.

## Известные Ограничения MVP

- Нет streaming ответа модели.
- Нет отмены уже запущенного AI-запроса.
- Нет серверного proxy: API key хранится в клиентских settings/cache.
- Tool calling зависит от совместимости провайдера с OpenAI Chat Completions.
- Tools видят только то, что доступно текущему Telegram клиенту и может быть
  догружено через существующий `callApi`.
- Часть UI-текстов TeleAgent пока захардкожена в компонентах, часть находится в
  localization fallback.
- Персистентность AI-чатов локальная, синхронизации между устройствами нет.

## Команды

Установка и web dev:

```sh
cp .env.example .env
npm i
npm run dev
```

Проверки:

```sh
npm run check
npm test
```

Tauri:

```sh
npm run tauri:dev
npm run tauri:build
```

Перед desktop production build Tauri сам вызывает `npm run build:production`.
