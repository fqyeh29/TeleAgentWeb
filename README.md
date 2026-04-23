# TeleAgent Web Fork

Рабочий форк [Ajaxy/telegram-tt](https://github.com/Ajaxy/telegram-tt), в котором Telegram Web A дорабатывается под встроенного AI-ассистента в правой боковой панели.

## Что Изменено В Форке

Относительно upstream в форке добавлен MVP TeleAgent AI:

- раздел настроек AI внутри приложения
- панель TeleAgent в правой колонке
- подключение OpenAI-compatible провайдера
- agent runtime с tool calling вместо одиночного запроса к модели
- локальные инструменты для работы с диалогами и сообщениями: `list_dialogs`, `search_dialogs`, `get_dialog_meta`, `read_dialog`, `search_messages`, `get_message_context`
- отображение текущей активности ассистента во время выполнения
- более аккуратный рендер текста ответов
- проброс текстов ошибок провайдера напрямую в UI

## Где Что Менялось

- `src/components/right/TeleAgentAi.tsx` - UI панели TeleAgent
- `src/components/right/TeleAgentAi.module.scss` - стили панели
- `src/global/actions/api/teleAgentAi.ts` - запуск TeleAgent и обновление состояния
- `src/lib/teleagent/openaiCompatibleClient.ts` - базовый OpenAI-compatible клиент
- `src/lib/teleagent/agentRuntime.ts` - runtime агента с циклом tool calls
- `src/lib/teleagent/tools.ts` - инструменты для чтения диалогов и сообщений Telegram
- `src/global/initialState.ts` - начальное состояние TeleAgent
- `src/global/types/tabState.ts` - типы состояния вкладки для TeleAgent

Подробная документация по форку, истории изменений и архитектуре находится в
[`docs/FORK.md`](docs/FORK.md).

## Прошлый Коммит

Предыдущая контрольная точка перед этой версией:

- commit: `b20c23e7e98d8eb6b3e69501beee4f89d66e436c`
- message: `feat: save teleagent ai integration progress`

Что уже было сделано в том коммите:

- добавлены настройки TeleAgent AI
- добавлен базовый UI в правой колонке
- добавлен OpenAI-compatible клиент
- добавлены начальные типы и состояние TeleAgent

## Текущее Состояние

Текущее состояние для `v0.1`:

- TeleAgent отвечает в боковой панели
- модель может сначала читать диалоги и сообщения через инструменты, а затем формировать ответ
- пользователь видит текущий этап обработки
- ответы рендерятся чище и удобнее для чтения
- ошибки провайдера и сервера видны в интерфейсе

Это первая рабочая версия AI-потока внутри форка.

## Быстрый Старт

```sh
cp .env.example .env
npm i
npm run dev
```

После этого заполните `.env` Telegram API-данными с [my.telegram.org](https://my.telegram.org).

## Настройка TeleAgent AI

В настройках приложения нужно указать:

- `API Base URL`
- `API Key`
- `Model`
- при необходимости `System Prompt`

Провайдер должен поддерживать OpenAI-compatible `chat/completions` и tool calling.

## Версия

- текущая версия форка: `0.1.0`
- статус: первая рабочая версия
