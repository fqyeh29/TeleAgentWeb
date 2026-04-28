import type {
  TeleAgentAiCompactionMode,
  TeleAgentAiDepth,
  TeleAgentAiError,
  TeleAgentAiMessage,
} from '../../types';

import {
  buildActivityStep,
  extractPhaseCommentTag,
  getFallbackHeadline,
  validatePhaseComment,
} from './activity';
import { getTeleAgentToolDefinitions } from './tools';

const DEFAULT_MAX_TOOL_ITERATIONS = 15;
const DEFAULT_MAX_RAW_TOOL_RESULT_CHARS = 7000;
const DEFAULT_MAX_COMPACT_TOOL_RESULT_CHARS = 5000;
const DEFAULT_MAX_COMPACT_MESSAGES = 8;
const DEFAULT_MAX_COMPACT_ITEMS = 10;
const DEFAULT_MAX_COMPACT_TEXT_CHARS = 220;
const DEFAULT_MAX_COMPACT_TARGET_TEXT_CHARS = 3500;

const TELEAGENT_AGENT_PROMPT = [
  'You are TeleAgent, an AI assistant embedded inside a Telegram client.',
  'You do not have access to all chats and messages up front.',
  'Use the available tools to discover dialogs, inspect metadata, search, and read messages before answering.',
  'Investigation policy:',
  '- Prefer this flow: search or list first, then read, then answer.',
  '- Do not conclude "not found" after one failed or empty search.',
  '- For search tasks, try at least 2 distinct strategies before giving up:',
  '  dialog search, global message search, current dialog, folder/unread scan,',
  '  or cursor pagination when hasMore is true.',
  '- If a tool result has hasMore=true and the answer is not yet supported,',
  '  request the next page unless the task is clearly simple and already answered.',
  '- Distinguish "no evidence found in searched scope" from "does not exist".',
  '- Before final answer, ensure you have enough evidence for the requested depth.',
  'Answer depth:',
  '- quick: concise answer, 1-2 tool calls if enough.',
  '- normal: inspect enough evidence to avoid shallow answers.',
  '- deep: use multiple searches/pages and produce a structured answer.',
  '- If the user pushes "search deeper", "look deeper", "more detail", "analyze",',
  '  "all", "for the period", or similar wording in any language, switch to deep mode.',
  'If the user refers to the current place in the UI without naming a chat, call get_current_dialog first.',
  'If get_current_dialog says there is no open dialog, say that clearly and ask the user to specify a chat.',
  'If the user asks about unread without an explicit scope, default to personal dialogs with people only.',
  'Do not include bots, groups, supergroups, or channels in default unread answers unless the user asked for them.',
  'Do not mix people, bots, groups, and channels together in one default unread answer.',
  'Never invent chat contents, participants, or message text.',
  'If the available tool data is insufficient, say that clearly.',
  'Do not claim to have actions or permissions that are not exposed as tools.',
  'Default to concise answers for simple tasks, but provide detailed, structured answers',
  'when the question requires investigation, comparison, chronology, or deeper search.',
  'Tool results are intentionally truncated and paginated, so request another page when needed.',
  'Tool results may be compact digests. Treat resultCount, hasMore, nextCursor, searched scope,',
  'and warning fields as part of the evidence.',
  'Message list and search tools return previews. If a message is important, marked isTextTruncated,',
  'or needed as evidence for your final answer, call get_message_context with chatId and messageId',
  'before drawing conclusions from that message.',
  'For pagination, prefer the opaque cursor returned by the tool. Do not use messageId as offset.',
  'When you are entering a new work phase, you may optionally include',
  'one short Russian UI comment using <phase_comment>...</phase_comment>.',
  'That phase comment is only for temporary live UI, not for the final answer.',
  'If you use it, keep it very short: 2-6 words, Russian, natural, no tool names, no JSON, no English.',
  'Do not include a phase comment on every step.',
].join('\n');

function getCurrentDateTimeContext() {
  const now = new Date();

  const formatted = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
  const formattedTime = [
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join(':');
  const formattedDateTime = `${formatted} ${formattedTime}`;

  return [
    'The tool only has data for past dates.',
    'When a date without year is given (e.g., "28 May"), automatically resolve it',
    `to the most recent past occurrence relative to today: ${formattedDateTime}.`,
    'Never use a future date.',
  ].join(' ');
}

type OpenAiCompatibleTool = {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required?: string[];
      additionalProperties?: boolean;
    };
  };
};

type OpenAiCompatibleMessage =
  | {
    role: 'system' | 'user' | 'tool';
    content: string;
    tool_call_id?: string;
  }
  | {
    role: 'assistant';
    content?: string;
    tool_calls?: Array<{
      id: string;
      type: 'function';
      function: {
        name: string;
        arguments: string;
      };
    }>;
  };

type OpenAiCompatibleResponse = {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
      tool_calls?: Array<{
        id?: string;
        type?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
  }>;
  error?: {
    message?: string;
  };
};

type OpenAiCompatibleAssistantMessage = NonNullable<
  NonNullable<OpenAiCompatibleResponse['choices']>[number]['message']
>;
type OpenAiCompatibleAssistantToolCall = NonNullable<OpenAiCompatibleAssistantMessage['tool_calls']>[number];

type JsonRecord = Record<string, unknown>;

type TeleAgentEvidenceItem = {
  id: string;
  source: {
    chatId?: string;
    chatTitle?: string;
    messageId?: number;
    timestamp?: number;
    timestampText?: string;
  };
  quoteOrSummary: string;
  relevance: string;
};

type TeleAgentCompactedToolResult = {
  content: string;
  evidenceItems: TeleAgentEvidenceItem[];
  stats: {
    rawChars: number;
    sentChars: number;
    wasCompacted: boolean;
  };
};

type TeleAgentCompactionConfig = {
  maxRawToolResultChars: number;
  maxCompactToolResultChars: number;
  maxCompactMessages: number;
  maxCompactItems: number;
  maxCompactTextChars: number;
  maxCompactTargetTextChars: number;
};

export type TeleAgentAgentRuntimeOptions = {
  apiBaseUrl: string;
  apiKey: string;
  model: string;
  systemPrompt?: string;
  defaultDepth?: TeleAgentAiDepth;
  maxToolIterations?: number;
  compactionMode?: TeleAgentAiCompactionMode;
  workspaceContext?: string;
  messages: TeleAgentAiMessage[];
  onActivity?: (activity?: {
    headline?: string;
    step?: {
      label: string;
    };
    status?: 'running' | 'error';
    errorText?: string;
    currentPhase?: string;
  }) => void;
};

export type TeleAgentAgentRuntimeResult = {
  text?: string;
  error?: TeleAgentAiError;
  errorMessage?: string;
};

function getDefaultDepthPrompt(defaultDepth: TeleAgentAiDepth = 'normal') {
  switch (defaultDepth) {
    case 'quick':
      return [
        'Default search depth for this session: quick.',
        'Prefer short investigations unless the user asks to dig deeper.',
      ].join(' ');
    case 'deep':
      return 'Default search depth for this session: deep. Prefer thorough investigation before answering.';
    case 'normal':
    default:
      return 'Default search depth for this session: normal. Investigate enough to avoid shallow answers.';
  }
}

function buildSystemPrompt(
  systemPrompt?: string,
  defaultDepth?: TeleAgentAiDepth,
  workspaceContext?: string,
) {
  const trimmedSystemPrompt = systemPrompt?.trim();
  const trimmedWorkspaceContext = workspaceContext?.trim();
  const promptParts = [
    TELEAGENT_AGENT_PROMPT,
    getDefaultDepthPrompt(defaultDepth),
    getCurrentDateTimeContext(),
    trimmedWorkspaceContext ? `Workspace context: ${trimmedWorkspaceContext}` : undefined,
  ].filter(Boolean);
  const promptWithDateTime = promptParts.join('\n');

  return trimmedSystemPrompt
    ? `${promptWithDateTime}\n\n${trimmedSystemPrompt}`
    : promptWithDateTime;
}

function clampToolIterations(value?: number) {
  const rounded = typeof value === 'number' && Number.isFinite(value)
    ? Math.round(value)
    : DEFAULT_MAX_TOOL_ITERATIONS;

  return Math.min(40, Math.max(3, rounded));
}

function getCompactionConfig(mode: TeleAgentAiCompactionMode = 'balanced'): TeleAgentCompactionConfig {
  switch (mode) {
    case 'aggressive':
      return {
        maxRawToolResultChars: 4500,
        maxCompactToolResultChars: 3200,
        maxCompactMessages: 5,
        maxCompactItems: 6,
        maxCompactTextChars: 160,
        maxCompactTargetTextChars: 2200,
      };
    case 'fuller':
      return {
        maxRawToolResultChars: 10000,
        maxCompactToolResultChars: 7000,
        maxCompactMessages: 10,
        maxCompactItems: 12,
        maxCompactTextChars: 320,
        maxCompactTargetTextChars: 4200,
      };
    case 'balanced':
    default:
      return {
        maxRawToolResultChars: DEFAULT_MAX_RAW_TOOL_RESULT_CHARS,
        maxCompactToolResultChars: DEFAULT_MAX_COMPACT_TOOL_RESULT_CHARS,
        maxCompactMessages: DEFAULT_MAX_COMPACT_MESSAGES,
        maxCompactItems: DEFAULT_MAX_COMPACT_ITEMS,
        maxCompactTextChars: DEFAULT_MAX_COMPACT_TEXT_CHARS,
        maxCompactTargetTextChars: DEFAULT_MAX_COMPACT_TARGET_TEXT_CHARS,
      };
  }
}

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, ' ').trim();
}

function truncateErrorText(value: string, maxChars = 220) {
  const normalized = normalizeWhitespace(value);
  if (!normalized) {
    return undefined;
  }

  return normalized.length > maxChars
    ? `${normalized.slice(0, maxChars).trimEnd()}...`
    : normalized;
}

function getReadableProviderErrorMessage(error?: TeleAgentAiError, rawMessage?: string) {
  const normalized = rawMessage ? normalizeWhitespace(rawMessage) : '';
  const lower = normalized.toLowerCase();

  if (lower) {
    if (
      lower.includes('context length')
      || lower.includes('maximum context')
      || lower.includes('max context')
      || lower.includes('too many tokens')
      || lower.includes('prompt is too long')
      || lower.includes('input is too long')
      || lower.includes('context window')
      || lower.includes('token limit')
    ) {
      return [
        'Запрос стал слишком большим для модели: переполнен контекст.',
        'Нужна более сильная компактизация или меньше истории.',
      ].join(' ');
    }

    if (
      lower.includes('rate limit')
      || lower.includes('too many requests')
      || lower.includes('quota')
    ) {
      return `AI-сервис отклонил запрос из-за лимита: ${truncateErrorText(normalized)}`;
    }

    if (
      lower.includes('api key')
      || lower.includes('unauthorized')
      || lower.includes('authentication')
      || lower.includes('invalid key')
      || lower.includes('forbidden')
    ) {
      return `AI-сервис отклонил учетные данные: ${truncateErrorText(normalized)}`;
    }

    if (
      lower.includes('model')
      && (lower.includes('not found') || lower.includes('does not exist') || lower.includes('unsupported'))
    ) {
      return `Проблема с моделью: ${truncateErrorText(normalized)}`;
    }

    return truncateErrorText(normalized);
  }

  switch (error) {
    case 'network':
      return 'Не удалось подключиться к AI-сервису.';
    case 'unauthorized':
      return 'AI-сервис отклонил учетные данные.';
    case 'server':
      return 'AI-сервис вернул ошибку.';
    case 'badResponse':
      return 'AI-сервис вернул некорректный ответ.';
    default:
      return undefined;
  }
}

function extractAssistantContentText(content: OpenAiCompatibleAssistantMessage['content']) {
  if (typeof content === 'string') {
    return content.trim();
  }

  if (Array.isArray(content)) {
    return content
      .filter(
        (part): part is { type?: string; text: string } => part?.type === 'text' && typeof part.text === 'string',
      )
      .map((part) => part.text.trim())
      .filter(Boolean)
      .join('\n')
      .trim();
  }

  return '';
}

function extractAssistantUiPayload(content: OpenAiCompatibleAssistantMessage['content']) {
  const text = extractAssistantContentText(content);
  const { phaseComment, text: cleanedText } = extractPhaseCommentTag(text);

  return {
    phaseComment: validatePhaseComment(phaseComment),
    text: cleanedText,
  };
}

function mapToolsToSchema() {
  return getTeleAgentToolDefinitions().map<OpenAiCompatibleTool>((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

async function requestChatCompletion({
  apiBaseUrl,
  apiKey,
  model,
  messages,
  tools,
}: {
  apiBaseUrl: string;
  apiKey: string;
  model: string;
  messages: OpenAiCompatibleMessage[];
  tools: OpenAiCompatibleTool[];
}): Promise<{
  message?: OpenAiCompatibleAssistantMessage;
  error?: TeleAgentAiError;
  errorMessage?: string;
}> {
  const normalizedBaseUrl = apiBaseUrl.trim().replace(/\/+$/, '');
  const requestUrl = `${normalizedBaseUrl}/chat/completions`;
  const trimmedApiKey = apiKey.trim();
  const trimmedModel = model.trim();

  if (!/^[\x20-\x7E]+$/.test(trimmedApiKey)) {
    return {
      error: 'invalidApiKey',
    };
  }

  let response: Response;
  try {
    response = await fetch(requestUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${trimmedApiKey}`,
      },
      body: JSON.stringify({
        model: trimmedModel,
        messages,
        tools,
        tool_choice: 'auto',
      }),
    });
  } catch (err) {
    return {
      error: 'network',
    };
  }

  let responseText: string;
  try {
    responseText = await response.text();
  } catch (err) {
    return {
      error: 'badResponse',
    };
  }

  let data: OpenAiCompatibleResponse | undefined;
  try {
    data = responseText ? JSON.parse(responseText) as OpenAiCompatibleResponse : undefined;
  } catch (err) {
    if (!response.ok) {
      return {
        error: response.status === 401 || response.status === 403 ? 'unauthorized' : 'server',
        errorMessage: truncateErrorText(responseText) || `HTTP ${response.status}`,
      };
    }

    return {
      error: 'badResponse',
      errorMessage: truncateErrorText(responseText),
    };
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      return {
        error: 'unauthorized',
        errorMessage: data?.error?.message,
      };
    }

    return {
      error: 'server',
      errorMessage: data?.error?.message,
    };
  }

  const message = data?.choices?.[0]?.message;
  if (!message) {
    return {
      error: 'badResponse',
      errorMessage: 'The provider returned no assistant message.',
    };
  }

  return { message };
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function asOptionalString(value: unknown) {
  return typeof value === 'string' && value ? value : undefined;
}

function asOptionalNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function truncateText(value: unknown, maxChars = DEFAULT_MAX_COMPACT_TEXT_CHARS) {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return undefined;
  }

  return normalized.length > maxChars
    ? `${normalized.slice(0, maxChars).trimEnd()}...`
    : normalized;
}

function getResultArray(record: JsonRecord) {
  if (Array.isArray(record.messages)) {
    return {
      key: 'messages',
      items: record.messages,
      kind: 'messages' as const,
    };
  }

  if (Array.isArray(record.results)) {
    return {
      key: 'results',
      items: record.results,
      kind: 'messages' as const,
    };
  }

  if (Array.isArray(record.surroundingMessages)) {
    return {
      key: 'surroundingMessages',
      items: record.surroundingMessages,
      kind: 'messages' as const,
    };
  }

  if (Array.isArray(record.items)) {
    return {
      key: 'items',
      items: record.items,
      kind: 'items' as const,
    };
  }

  return undefined;
}

function compactMessageItem(item: unknown, maxTextChars = DEFAULT_MAX_COMPACT_TEXT_CHARS) {
  if (!isRecord(item)) {
    return item;
  }

  return {
    chatId: asOptionalString(item.chatId),
    chatTitle: asOptionalString(item.chatTitle),
    messageId: asOptionalNumber(item.messageId),
    author: asOptionalString(item.author),
    timestamp: asOptionalNumber(item.timestamp),
    timestampText: asOptionalString(item.timestampText),
    text: truncateText(item.text, maxTextChars),
    isTextTruncated: typeof item.isTextTruncated === 'boolean' ? item.isTextTruncated : undefined,
  };
}

function compactListItem(item: unknown) {
  if (!isRecord(item)) {
    return item;
  }

  return {
    chatId: asOptionalString(item.chatId),
    title: asOptionalString(item.title),
    type: asOptionalString(item.type),
    unreadCount: asOptionalNumber(item.unreadCount),
    lastActivityAt: asOptionalNumber(item.lastActivityAt),
    lastActivityAtText: asOptionalString(item.lastActivityAtText),
    folderId: asOptionalNumber(item.folderId),
    order: asOptionalNumber(item.order),
    isDefault: typeof item.isDefault === 'boolean' ? item.isDefault : undefined,
  };
}

function stripUndefinedFields(record: JsonRecord) {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined),
  );
}

function getSearchedScope(args: unknown) {
  if (!isRecord(args)) {
    return undefined;
  }

  const searched = stripUndefinedFields({
    query: Array.isArray(args.query) ? args.query : asOptionalString(args.query),
    chatId: asOptionalString(args.chatId),
    dateFrom: asOptionalString(args.dateFrom),
    dateTo: asOptionalString(args.dateTo),
    limit: asOptionalNumber(args.limit),
    cursor: asOptionalString(args.cursor),
    offset: asOptionalNumber(args.offset),
    scope: asOptionalString(args.scope),
    folderId: asOptionalNumber(args.folderId),
    direction: asOptionalString(args.direction),
  });

  return Object.keys(searched).length ? searched : undefined;
}

function extractPagination(record: JsonRecord) {
  return stripUndefinedFields({
    hasMore: typeof record.hasMore === 'boolean' ? record.hasMore : undefined,
    nextCursor: asOptionalString(record.nextCursor),
    nextOffset: asOptionalNumber(record.nextOffset),
  });
}

function buildEvidenceItem(toolName: string, item: unknown, index: number): TeleAgentEvidenceItem | undefined {
  if (!isRecord(item)) {
    return undefined;
  }

  const text = truncateText(item.text);
  if (!text) {
    return undefined;
  }

  const messageId = asOptionalNumber(item.messageId);
  const chatId = asOptionalString(item.chatId);

  return {
    id: [
      toolName,
      chatId || 'unknown-chat',
      messageId ?? index,
    ].join(':'),
    source: {
      chatId,
      chatTitle: asOptionalString(item.chatTitle),
      messageId,
      timestamp: asOptionalNumber(item.timestamp),
      timestampText: asOptionalString(item.timestampText),
    },
    quoteOrSummary: text,
    relevance: `Returned by ${toolName}.`,
  };
}

function stringifyToolPayload(payload: unknown) {
  return JSON.stringify(payload) || 'null';
}

function limitCompactContent(content: string, maxChars = DEFAULT_MAX_COMPACT_TOOL_RESULT_CHARS) {
  if (content.length <= maxChars) {
    return content;
  }

  return stringifyToolPayload({
    compacted: true,
    warning: 'Compact tool result was still large and was shortened for model context.',
    preview: `${content.slice(0, maxChars).trimEnd()}...`,
  });
}

function compactToolResultForModel(
  toolName: string,
  args: unknown,
  result: unknown,
  compactionConfig: TeleAgentCompactionConfig,
): TeleAgentCompactedToolResult {
  const raw = stringifyToolPayload(result);

  if (isRecord(result) && result.ok === false) {
    return {
      content: raw,
      evidenceItems: [],
      stats: {
        rawChars: raw.length,
        sentChars: raw.length,
        wasCompacted: false,
      },
    };
  }

  if (raw.length <= compactionConfig.maxRawToolResultChars) {
    return {
      content: raw,
      evidenceItems: [],
      stats: {
        rawChars: raw.length,
        sentChars: raw.length,
        wasCompacted: false,
      },
    };
  }

  if (!isRecord(result)) {
    const content = limitCompactContent(stringifyToolPayload({
      tool: toolName,
      compacted: true,
      warning: 'Raw non-object tool result was too large and was shortened for model context.',
      preview: `${raw.slice(0, compactionConfig.maxCompactToolResultChars).trimEnd()}...`,
    }), compactionConfig.maxCompactToolResultChars);

    return {
      content,
      evidenceItems: [],
      stats: {
        rawChars: raw.length,
        sentChars: content.length,
        wasCompacted: true,
      },
    };
  }

  const resultArray = getResultArray(result);
  const pagination = extractPagination(result);
  const searched = getSearchedScope(args);
  const evidenceItems = resultArray?.kind === 'messages'
    ? resultArray.items
      .slice(0, compactionConfig.maxCompactMessages)
      .map((item, index) => buildEvidenceItem(toolName, item, index))
      .filter((item): item is TeleAgentEvidenceItem => Boolean(item))
    : [];

  const compactedPayload: JsonRecord = stripUndefinedFields({
    tool: toolName,
    searched,
    resultCount: resultArray?.items.length,
    totalKnown: asOptionalNumber(result.totalKnown),
    scope: asOptionalString(result.scope),
    chatId: asOptionalString(result.chatId),
    target: isRecord(result.target)
      ? compactMessageItem(result.target, compactionConfig.maxCompactTargetTextChars)
      : undefined,
    [resultArray?.key || 'items']: resultArray
      ? resultArray.items
        .slice(0, resultArray.kind === 'messages'
          ? compactionConfig.maxCompactMessages
          : compactionConfig.maxCompactItems)
        .map(resultArray.kind === 'messages'
          ? (item) => compactMessageItem(item, compactionConfig.maxCompactTextChars)
          : compactListItem)
        .map((item) => (isRecord(item) ? stripUndefinedFields(item) : item))
      : undefined,
    ...pagination,
    compacted: true,
    warning: [
      'Raw tool result was compacted for model context.',
      'Use hasMore/nextCursor to continue pagination when evidence is insufficient.',
    ].join(' '),
  });

  const content = limitCompactContent(
    stringifyToolPayload(compactedPayload),
    compactionConfig.maxCompactToolResultChars,
  );

  return {
    content,
    evidenceItems,
    stats: {
      rawChars: raw.length,
      sentChars: content.length,
      wasCompacted: true,
    },
  };
}

export async function runTeleAgentAgentRuntime({
  apiBaseUrl,
  apiKey,
  model,
  systemPrompt,
  defaultDepth,
  maxToolIterations,
  compactionMode,
  workspaceContext,
  messages,
  onActivity,
}: TeleAgentAgentRuntimeOptions): Promise<TeleAgentAgentRuntimeResult> {
  const toolDefinitions = getTeleAgentToolDefinitions();
  const toolsByName = new Map(toolDefinitions.map((tool) => [tool.name, tool]));
  const toolSchemas = mapToolsToSchema();
  const effectiveMaxToolIterations = clampToolIterations(maxToolIterations);
  const compactionConfig = getCompactionConfig(compactionMode);
  const conversation: OpenAiCompatibleMessage[] = [
    {
      role: 'system',
      content: buildSystemPrompt(systemPrompt, defaultDepth, workspaceContext),
    },
    ...messages.map((message) => ({
      role: message.role,
      content: message.text,
    })),
  ];
  let stepIndex = 0;

  for (let iteration = 0; iteration < effectiveMaxToolIterations; iteration++) {
    if (iteration === 0) {
      onActivity?.({
        headline: 'Обдумываю ответ',
        status: 'running',
      });
    }

    const completion = await requestChatCompletion({
      apiBaseUrl,
      apiKey,
      model,
      messages: conversation,
      tools: toolSchemas,
    });

    if (completion.error) {
      const readableError = getReadableProviderErrorMessage(completion.error, completion.errorMessage);

      onActivity?.({
        headline: 'Не удалось завершить запрос',
        status: 'error',
        errorText: readableError || 'Что-то пошло не так во время обработки запроса',
      });
      return {
        error: completion.error,
        errorMessage: readableError || completion.errorMessage,
      };
    }

    const assistantMessage = completion.message!;
    const { phaseComment, text: assistantText } = extractAssistantUiPayload(assistantMessage.content);
    const toolCalls = assistantMessage.tool_calls
      ?.filter((toolCall: OpenAiCompatibleAssistantToolCall): toolCall is {
        id: string;
        type: 'function';
        function: {
          name: string;
          arguments: string;
        };
      } => {
        return Boolean(
          toolCall.id
          && toolCall.type === 'function'
          && toolCall.function?.name
          && typeof toolCall.function.arguments === 'string',
        );
      });

    if (!toolCalls?.length) {
      const text = assistantText;

      if (!text) {
        onActivity?.({
          headline: 'Не удалось завершить запрос',
          status: 'error',
          errorText: 'Модель не вернула итоговый ответ',
        });

        return {
          error: 'badResponse',
          errorMessage: 'The model did not return a final answer or a tool call.',
        };
      }

      onActivity?.(undefined);
      return { text };
    }

    conversation.push({
      role: 'assistant',
      content: assistantText || undefined,
      tool_calls: toolCalls,
    });

    onActivity?.({
      headline: phaseComment || getFallbackHeadline(toolCalls.map((toolCall) => toolCall.function.name)),
      status: 'running',
      currentPhase: phaseComment,
    });

    for (const toolCall of toolCalls) {
      const tool = toolsByName.get(toolCall.function.name);

      let result: unknown;
      let parsedArguments: unknown = {};
      try {
        parsedArguments = toolCall.function.arguments
          ? JSON.parse(toolCall.function.arguments)
          : {};

        if (!tool) {
          throw new Error(`Unknown tool "${toolCall.function.name}".`);
        }

        result = await tool.execute(parsedArguments);
      } catch (err) {
        result = {
          ok: false,
          error: err instanceof Error ? err.message : 'Tool execution failed.',
        };

        onActivity?.({
          headline: phaseComment || getFallbackHeadline([toolCall.function.name]),
          step: buildActivityStep(toolCall.function.name, ++stepIndex),
          status: 'error',
          errorText: 'Не удалось выполнить один из шагов',
        });
      }

      if (!(result && typeof result === 'object' && 'ok' in result && (result as { ok?: boolean }).ok === false)) {
        onActivity?.({
          headline: phaseComment || getFallbackHeadline([toolCall.function.name]),
          step: buildActivityStep(toolCall.function.name, ++stepIndex),
          status: 'running',
          currentPhase: phaseComment,
        });
      }

      conversation.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: compactToolResultForModel(
          toolCall.function.name,
          parsedArguments,
          result,
          compactionConfig,
        ).content,
      });
    }
  }

  onActivity?.({
    headline: 'Не удалось завершить запрос',
    status: 'error',
    errorText: 'Превышен лимит шагов, итоговый ответ не получен',
  });

  return {
    error: 'badResponse',
    errorMessage: [
      'TeleAgent reached the tool-iteration limit',
      `(${effectiveMaxToolIterations}) before producing a final answer.`,
    ].join(' '),
  };
}
