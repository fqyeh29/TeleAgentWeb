# TeleAgent Agent Roadmap

Цель документа - превратить TeleAgent из MVP sidebar-ассистента в уверенного
tool-using агента, который умеет глубоко искать, не переполняет контекст и дает
содержательные ответы. Это дорожная карта для людей и LLM-агентов, которые
будут развивать `src/lib/teleagent`.

TeleAgent сейчас уже на правильном пути: у него есть agent runtime, tools,
activity UI и локальная история AI-чатов. Но он ведет себя как младший агент:
делает 2-3 tool calls, не находит очевидное, боится копать глубже, а если его
толкать - переполняет conversation сырыми tool results. Ниже план, как сделать
его ближе к Codex-подобному поведению.

## Главные Проблемы

### 1. Агент слишком рано сдается

Симптомы:

- вызывает 2-3 tools и отвечает "не нашел";
- редко использует `hasMore` и `nextCursor`;
- не делает systematic search plan;
- не отличает "ничего нет" от "я посмотрел слишком мало".

Причина:

- runtime отдает модели полную свободу через `tool_choice: "auto"`;
- system prompt говорит "use tools", но не задает минимальную исследовательскую
  дисциплину;
- tool results не содержат явного guidance: что проверено, что осталось, какой
  следующий шаг разумен.

### 2. Глубокий поиск переполняет контекст

Симптомы:

- если пользователь заставляет искать глубже, conversation раздувается;
- каждое чтение сообщений добавляет большой JSON в историю модели;
- старые tool results остаются в active context, даже если из них уже извлечены
  факты;
- модель начинает терять фокус или отвечать хуже.

Причина:

- нет слоя working memory/evidence;
- runtime хранит все tool outputs как raw `role: "tool"` messages;
- нет compaction после этапов поиска;
- нет budget manager для токенов, evidence и pages.

### 3. Ответы поверхностные и слишком краткие

Симптомы:

- ответы выглядят как quick summary вместо анализа;
- мало конкретики: нет дат, имен, message ids, причин уверенности;
- агент отвечает сразу, когда надо сначала собрать evidence;
- "Keep answers concise" в prompt перетягивает поведение в сторону краткости
  даже для сложных задач.

Причина:

- prompt оптимизирован под sidebar MVP, а не под исследование;
- нет answer depth policy;
- нет требования опираться на evidence;
- UI не предлагает режимы глубины: quick / normal / deep.

## Принцип Codex-Поведения

Codex не "помнит весь проект". Он уверенно работает с большим объемом потому,
что использует инструменты как внешнюю память:

- сначала ищет карту местности;
- читает только релевантные файлы;
- сжимает наблюдения в рабочую модель;
- проверяет гипотезы через tools;
- делает изменения только после достаточного контекста;
- держит пользователя в курсе activity;
- не считает первый неудачный поиск доказательством отсутствия результата.

Для TeleAgent аналог такой:

- не загружать весь Telegram в модель;
- искать итеративно;
- хранить краткое состояние расследования;
- превращать raw messages в evidence notes;
- продолжать поиск по cursor, пока не достигнут confidence или budget;
- отвечать глубже, когда задача требует глубины.

## Целевая Архитектура

### Agent Runtime 2

Файл: `src/lib/teleagent/agentRuntime.ts`

Нынешний цикл:

```text
messages -> model -> tool calls -> raw tool results -> model -> final answer
```

Целевой цикл:

```text
user task
-> classify task and desired depth
-> create investigation plan
-> execute tool calls
-> extract compact evidence
-> compact or discard raw tool results
-> decide continue / answer / ask clarification
-> final answer with evidence awareness
```

Главное отличие: raw tool results не должны бесконечно копиться в context.
Runtime должен вести отдельную `workingMemory`.

### Working Memory

Добавить внутреннюю структуру, которая не равна AI-chat history:

```ts
type TeleAgentWorkingMemory = {
  task: string;
  depth: 'quick' | 'normal' | 'deep';
  plan: string[];
  searched: Array<{
    toolName: string;
    scope: string;
    pagesRead: number;
    hasMore?: boolean;
    nextCursor?: string;
  }>;
  evidence: TeleAgentEvidenceItem[];
  openQuestions: string[];
  confidence: 'low' | 'medium' | 'high';
};

type TeleAgentEvidenceItem = {
  id: string;
  source: {
    chatId?: string;
    chatTitle?: string;
    messageId?: number;
    timestamp?: number;
  };
  quoteOrSummary: string;
  relevance: string;
};
```

Working memory можно передавать модели как compact system/developer message
между итерациями, а raw tool result хранить только до извлечения evidence.

## Roadmap

## Phase 1: Prompt Discipline

Цель: перестать сдаваться после 2-3 calls.

Файл: `src/lib/teleagent/agentRuntime.ts`

Заменить общий prompt "Prefer this flow" на более явную исследовательскую
дисциплину:

```text
Investigation policy:
- Do not conclude "not found" after one failed search.
- For search tasks, try at least 2 distinct strategies before giving up:
  dialog search, global message search, current dialog, folder/unread scan,
  or cursor pagination when hasMore is true.
- If a tool result has hasMore=true and the answer is not yet supported,
  request the next page unless the task budget is exhausted.
- Distinguish "no evidence found in searched scope" from "does not exist".
- Before final answer, ensure you have enough evidence for the requested depth.
```

Добавить depth policy:

```text
Answer depth:
- quick: concise answer, 1-2 tool calls if enough.
- normal: inspect enough evidence to avoid shallow answers.
- deep: use multiple searches/pages and produce a structured answer.
- If the user pushes "ищи глубже", switch to deep mode.
```

Убрать или ослабить:

```text
Keep answers concise and useful for the user in the sidebar.
```

Заменить на:

```text
Default to concise answers for simple tasks, but provide detailed, structured
answers when the question requires investigation, comparison, chronology,
or when the user asks to search deeper.
```

Acceptance criteria:

- агент не отвечает "не нашел" после одной пустой страницы;
- при `hasMore=true` он чаще продолжает pagination;
- сложные вопросы получают structured answer, а не одну строку.

## Phase 2: Tool Result Compaction

Цель: глубокий поиск не должен переполнять context.

Файл: `src/lib/teleagent/agentRuntime.ts`

Сейчас `serializeToolResult` кладет JSON прямо в conversation. Нужно добавить
слой compaction:

1. Выполнить tool.
2. Передать модели raw result только если он небольшой.
3. Для больших results создать compact digest:
   - что искали;
   - сколько элементов;
   - top relevant items;
   - nextCursor/hasMore;
   - warning о truncation.
4. Сохранить полную версию локально в runtime trace, но не отправлять в модель
   повторно.

Новая функция:

```ts
function compactToolResultForModel(toolName: string, result: unknown): {
  content: string;
  evidenceItems?: TeleAgentEvidenceItem[];
  stats: {
    rawChars: number;
    sentChars: number;
    wasCompacted: boolean;
  };
}
```

Для message results отправлять модели не весь объект, а компактный формат:

```json
{
  "tool": "read_dialog",
  "chatId": "...",
  "messages": [
    {
      "messageId": 123,
      "author": "Name",
      "timestampText": "2026-04-23 10:15",
      "text": "short preview"
    }
  ],
  "hasMore": true,
  "nextCursor": "..."
}
```

Acceptance criteria:

- 10-15 tool calls не взрывают context;
- repeated pagination сохраняет только compact evidence;
- final answer продолжает видеть важные факты из ранних pages.

## Phase 3: Investigation Budget

Цель: агент должен искать достаточно глубоко, но не бесконечно.

Добавить budget в runtime:

```ts
type TeleAgentInvestigationBudget = {
  maxToolIterations: number;
  maxPagesPerTool: number;
  maxEvidenceItems: number;
  maxModelContextChars: number;
  maxWallClockMs: number;
};
```

Режимы:

- `quick`: 3 tool iterations, 1 page per scope.
- `normal`: 8 tool iterations, 2-3 pages per scope.
- `deep`: 20 tool iterations, 5+ pages per scope, stronger compaction.

Depth можно определять по запросу:

- "быстро", "кратко" -> quick;
- обычный вопрос -> normal;
- "найди", "проанализируй", "все", "глубже", "подробно", "за период" -> deep.

Важно: budget должен быть виден модели:

```text
Current search budget: deep.
You may call up to 20 tools.
Use pagination when hasMore=true and evidence is insufficient.
Stop when confidence is high or budget is exhausted.
```

Acceptance criteria:

- агент не боится 8-15 calls в deep mode;
- после budget exhaustion отвечает честно: что проверил, где могло остаться;
- пользователь видит progress, а не молчание.

## Phase 4: Evidence-Aware Answers

Цель: ответы должны быть не поверхностными, а доказательными.

Добавить правило final answer:

```text
Final answer policy:
- Answer from gathered evidence, not from assumptions.
- For factual chat/message answers, mention concrete dates, chats, people,
  or message ids when useful.
- If evidence is thin, say what was searched and what was not.
- For deep tasks, include:
  1. Short conclusion.
  2. Key findings.
  3. Evidence / examples.
  4. Remaining uncertainty.
```

Можно добавить скрытый internal checklist перед финалом:

```text
Before final answer, check:
- Did I inspect the right scope?
- Did I read messages, not only dialog titles?
- Did I follow nextCursor when needed?
- Is my answer supported by evidence?
- Would a user consider this too shallow?
```

Acceptance criteria:

- вместо "не нашел" агент пишет "проверил X, Y, Z; в этих местах не нашел";
- глубокие ответы содержат выводы и evidence;
- краткость остается для простых вопросов.

## Phase 5: Better Tools

Цель: дать модели инструменты не только для чтения, но и для навигации по
исследованию.

### Add `resolve_dialog_reference`

Назначение: превратить человеческое описание чата в candidates.

Input:

```json
{
  "query": "чат с Сашей про дизайн",
  "limit": 10
}
```

Output:

```json
{
  "candidates": [
    {
      "chatId": "...",
      "title": "Саша",
      "type": "private",
      "matchReason": "title match + recent activity",
      "confidence": "medium"
    }
  ]
}
```

### Add `search_messages_deep`

Назначение: один tool делает managed pagination и возвращает compact evidence.
Это снижает число model-tool roundtrips.

Input:

```json
{
  "query": "релиз",
  "chatId": "...",
  "dateFrom": "2026-04-01",
  "dateTo": "2026-04-23",
  "pages": 3,
  "limitPerPage": 20
}
```

Output:

```json
{
  "searchedPages": 3,
  "matches": [...],
  "hasMore": true,
  "nextCursor": "...",
  "coverage": "first 60 text matches in selected dialog"
}
```

### Add `summarize_message_batch`

Назначение: компактно пересказать страницу сообщений локально или через
дешевый model call, не засоряя основной context.

Output должен содержать:

- key facts;
- open loops;
- decisions;
- people mentioned;
- dates/deadlines;
- evidence message ids.

### Add `get_investigation_state`

Назначение: дать модели видеть, что уже проверено, без повторной прокрутки
всего context.

Acceptance criteria:

- меньше повторных одинаковых searches;
- deep search можно делать одним controlled tool;
- модель получает candidates и coverage, а не хаос из raw messages.

## Phase 6: Runtime Trace And Debug UI

Цель: понимать, почему агент сдался или переполнил context.

Добавить runtime trace:

```ts
type TeleAgentTrace = {
  requestId: string;
  startedAt: number;
  depth: 'quick' | 'normal' | 'deep';
  toolCalls: Array<{
    name: string;
    args: unknown;
    durationMs: number;
    rawChars: number;
    sentChars: number;
    hasMore?: boolean;
    error?: string;
  }>;
  finalConfidence?: 'low' | 'medium' | 'high';
  contextStats: {
    messageCount: number;
    approximateChars: number;
  };
};
```

UI:

- показывать "проверено 4 диалога, 53 сообщения";
- показывать expandable work log;
- в debug mode показывать raw tool names/args;
- добавить кнопку "Продолжить глубже", которая запускает deep continuation с
  сохраненной working memory.

Acceptance criteria:

- можно объяснить каждый плохой ответ;
- пользователь видит усилие агента;
- "толкание" пользователя превращается в нормальную кнопку continuation.

## Phase 7: Continuations Instead Of User Pushing

Цель: когда данных мало, агент сам предлагает следующий шаг.

Вместо финального:

```text
Не нашел.
```

Должно быть:

```text
В проверенных местах не нашел. Я просмотрел текущий чат и первые 2 страницы
поиска по запросу "релиз". Могу продолжить глубже: проверить старые сообщения,
папки и похожие формулировки.
```

В runtime добавить continuation payload:

```ts
type TeleAgentContinuation = {
  label: string;
  nextDepth: 'normal' | 'deep';
  workingMemorySnapshot: TeleAgentWorkingMemory;
  suggestedPrompt: string;
};
```

UI может показать кнопку:

- "Искать глубже"
- "Проверить другие чаты"
- "Расширить период"

Acceptance criteria:

- пользователь не обязан вручную "пинать" агента;
- continuation продолжает с прошлого состояния;
- deep search не начинает с нуля.

## Phase 8: Model And API Strategy

Цель: не зависеть от одного OpenAI-compatible поведения.

Ввести provider abstraction:

```ts
type TeleAgentModelCapabilities = {
  tools: boolean;
  streaming: boolean;
  reasoningEffort?: boolean;
  parallelToolCalls?: boolean;
  responseFormat?: boolean;
};
```

Runtime должен уметь:

- включать streaming, если provider поддерживает;
- просить больше reasoning для deep mode, если API это позволяет;
- отключать complex agent flow для моделей без tools;
- логировать provider capabilities в debug trace.

Если provider неуверенно вызывает tools, компенсировать runtime-driven
стратегией:

- первый model call просит plan;
- runtime сам вызывает рекомендуемые tools;
- второй model call получает compact evidence;
- модель отвечает.

Это особенно важно для слабых или локальных моделей.

## Конкретные Быстрые Правки

Если нужен быстрый эффект без большой архитектуры:

1. В `TELEAGENT_AGENT_PROMPT` заменить "Keep answers concise" на depth-aware
   правило.
2. Добавить explicit instruction: не сдаваться после одного пустого поиска.
3. Уменьшить `MAX_TOOL_RESULT_CHARS` для raw JSON и добавить более умный compact
   format.
4. В tool descriptions добавить фразы:
   - "If hasMore is true, call this tool again with nextCursor when evidence is insufficient."
   - "An empty page is not proof that the item does not exist outside searched scope."
5. В final answer требовать "what I checked" для low-confidence answers.
6. Добавить кнопку/команду "Искать глубже".

## Definition Of Done

TeleAgent станет заметно ближе к Codex-поведению, когда:

- он сам делает 8-15 tool calls в deep задачах без уговоров;
- он не переполняет context после нескольких pages;
- он умеет сказать, что именно проверил;
- он продолжает поиск по `nextCursor`, когда evidence недостаточно;
- его глубокие ответы содержат вывод, факты, примеры и uncertainty;
- пользователь видит work log и может продолжить расследование одной кнопкой;
- плохой ответ можно debug-нуть через trace.

## Напутствие Младшему Брату

Не будь чат-ботом, который угадывает. Будь клиентским агентом, который проверяет.

Тебе не нужно знать все сразу. У тебя есть tools. Сначала найди карту, потом
читай, потом сжимай наблюдения, потом решай, достаточно ли доказательств.
Не путай "я не посмотрел" с "этого нет". Не бойся сделать еще один аккуратный
tool call, если он приближает к ответу. Но и не тащи весь мир в context: бери
факты, ids, даты, короткие выдержки и продолжай.

Хороший агент не самый многословный. Хороший агент умеет честно показать путь
от вопроса до вывода.

