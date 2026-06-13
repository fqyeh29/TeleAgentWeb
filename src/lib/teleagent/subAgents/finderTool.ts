import type { TeleAgentAiDepth } from '../../../types';
import type { TeleAgentToolDefinition } from '../toolTypes';

type FindInTelegramInput = {
  goal: string;
  scopeHint?: string;
  chatHint?: string;
  dateFrom?: string;
  dateTo?: string;
  depth?: TeleAgentAiDepth;
};

type FinderSearchedItem = {
  kind: 'dialog_search' | 'message_search' | 'dialog_read' | 'message_context' | 'folder_scan' | 'unread_scan';
  chatId?: string;
  query?: string;
  scope?: string;
  cursor?: string;
  status: 'done' | 'partial';
  note?: string;
};

type FinderSavedItem = {
  kind: 'message' | 'dialog' | 'link' | 'fact';
  chatId?: string;
  chatTitle?: string;
  messageId?: number;
  value: string;
  label?: string;
};

type FinderMemory = {
  searched: FinderSearchedItem[];
  saved: FinderSavedItem[];
  next: string[];
};

type FinderStepResponse = {
  memory: FinderMemory;
  status: 'continue' | 'finish';
  toolCalls: Array<{
    name: string;
    arguments: Record<string, unknown>;
  }>;
  result?: {
    summary: string;
    confidence: 'low' | 'medium' | 'high';
    notFoundReason?: string;
  };
};

type FinderToolResult = {
  ok: true;
  summary: string;
  confidence: 'low' | 'medium' | 'high';
  evidence: Array<{
    chatId?: string;
    chatTitle?: string;
    messageId?: number;
    text: string;
    whyItMatters?: string;
  }>;
  searchedSummary: string[];
  notFoundReason?: string;
};

type OpenAiCompatibleMessage = {
  role: 'system' | 'user';
  content: string;
};

type OpenAiCompatibleResponse = {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
  error?: {
    message?: string;
  };
};

type OpenAiCompatibleContent = string | Array<{ type?: string; text?: string }> | undefined;

type FinderToolDependencies = {
  apiBaseUrl: string;
  apiKey: string;
  model: string;
  tools: TeleAgentToolDefinition[];
};

const FINDER_TOOL_NAME = 'find_in_telegram';

const FINDER_PROMPT = [
  'You are a search sub-agent inside TeleAgent.',
  'Your only job is to search Telegram data systematically and keep compact internal notes.',
  'You are not the final assistant for the user.',
  'You receive:',
  '- the concrete search task,',
  '- your current memory,',
  '- fresh tool results from the latest step only.',
  'You must return valid JSON only.',
  'Use memory.searched to record where you already searched.',
  'Use memory.saved to keep useful dialog ids, message ids, links, and short factual notes.',
  'Use memory.next to keep the next best leads.',
  'Do not copy large raw tool results into memory.',
  'Do not repeat the same search scope unless the hypothesis changed.',
  'If hasMore=true and evidence is insufficient, continue pagination.',
  'Distinguish "not found in searched scope" from "not found anywhere".',
  'When you finish, return status="finish" and result.summary/confidence.',
  'When you need more data, return status="continue" and toolCalls.',
  'Do not use markdown fences. Output JSON only.',
].join('\n');

function getMaxIterations(depth: TeleAgentAiDepth = 'normal') {
  switch (depth) {
    case 'quick':
      return 4;
    case 'deep':
      return 15;
    case 'normal':
    default:
      return 8;
  }
}

function asRecord(value: unknown, label: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }

  return value as Record<string, unknown>;
}

function asOptionalString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function asOptionalNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function truncateText(value: unknown, maxChars = 240) {
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

function extractAssistantContentText(content: OpenAiCompatibleContent) {
  if (typeof content === 'string') {
    return content.trim();
  }

  if (Array.isArray(content)) {
    return content
      .filter((part): part is { type?: string; text: string } => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text.trim())
      .filter(Boolean)
      .join('\n')
      .trim();
  }

  return '';
}

function stripCodeFences(value: string) {
  const trimmed = value.trim();

  if (!trimmed.startsWith('```')) {
    return trimmed;
  }

  return trimmed
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim();
}

async function requestPlainChatCompletion({
  apiBaseUrl,
  apiKey,
  model,
  messages,
}: {
  apiBaseUrl: string;
  apiKey: string;
  model: string;
  messages: OpenAiCompatibleMessage[];
}) {
  const normalizedBaseUrl = apiBaseUrl.trim().replace(/\/+$/, '');
  const requestUrl = `${normalizedBaseUrl}/chat/completions`;

  const response = await fetch(requestUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey.trim()}`,
    },
    body: JSON.stringify({
      model: model.trim(),
      messages,
    }),
  });

  const responseText = await response.text();
  let data: OpenAiCompatibleResponse | undefined;

  try {
    data = responseText ? JSON.parse(responseText) as OpenAiCompatibleResponse : undefined;
  } catch (err) {
    throw new Error(
      response.ok ? 'Finder provider returned invalid JSON.' : responseText || `HTTP ${response.status}`,
      { cause: err },
    );
  }

  if (!response.ok) {
    throw new Error(data?.error?.message || `Finder provider error HTTP ${response.status}.`);
  }

  const content = extractAssistantContentText(data?.choices?.[0]?.message?.content);
  if (!content) {
    throw new Error('Finder model returned no content.');
  }

  return content;
}

function sanitizeFinderMemory(memory: unknown): FinderMemory {
  const record = asRecord(memory, 'memory');
  const searched = Array.isArray(record.searched) ? record.searched : [];
  const saved = Array.isArray(record.saved) ? record.saved : [];
  const next = Array.isArray(record.next) ? record.next : [];

  return {
    searched: searched.slice(0, 15).map((item) => {
      const parsed = asRecord(item, 'memory.searched item');

      return {
        kind: (asOptionalString(parsed.kind) as FinderSearchedItem['kind']) || 'message_search',
        chatId: asOptionalString(parsed.chatId),
        query: truncateText(parsed.query, 120),
        scope: truncateText(parsed.scope, 160),
        cursor: truncateText(parsed.cursor, 120),
        status: asOptionalString(parsed.status) === 'partial' ? 'partial' : 'done',
        note: truncateText(parsed.note, 160),
      };
    }),
    saved: saved.slice(0, 12).map((item) => {
      const parsed = asRecord(item, 'memory.saved item');

      return {
        kind: (asOptionalString(parsed.kind) as FinderSavedItem['kind']) || 'fact',
        chatId: asOptionalString(parsed.chatId),
        chatTitle: truncateText(parsed.chatTitle, 80),
        messageId: asOptionalNumber(parsed.messageId),
        value: truncateText(parsed.value, 220) || 'Saved item',
        label: truncateText(parsed.label, 120),
      };
    }),
    next: next
      .slice(0, 5)
      .map((item) => truncateText(item, 120))
      .filter((item): item is string => Boolean(item)),
  };
}

function sanitizeFinderStepResponse(value: unknown): FinderStepResponse {
  const record = asRecord(value, 'finder step response');
  const status = asOptionalString(record.status);
  const rawToolCalls = Array.isArray(record.toolCalls) ? record.toolCalls : [];
  const resultRecord = record.result && typeof record.result === 'object' && !Array.isArray(record.result)
    ? record.result as Record<string, unknown>
    : undefined;

  return {
    memory: sanitizeFinderMemory(record.memory || {}),
    status: status === 'finish' ? 'finish' : 'continue',
    toolCalls: rawToolCalls.slice(0, 3).map((toolCall) => {
      const parsed = asRecord(toolCall, 'toolCall');
      return {
        name: asOptionalString(parsed.name) || '',
        arguments: (parsed.arguments && typeof parsed.arguments === 'object' && !Array.isArray(parsed.arguments)
          ? parsed.arguments
          : {}) as Record<string, unknown>,
      };
    }).filter((toolCall) => toolCall.name),
    result: resultRecord ? {
      summary: truncateText(resultRecord.summary, 320) || 'Search completed.',
      confidence: asOptionalString(resultRecord.confidence) === 'high'
        ? 'high'
        : asOptionalString(resultRecord.confidence) === 'medium'
          ? 'medium'
          : 'low',
      notFoundReason: truncateText(resultRecord.notFoundReason, 220),
    } : undefined,
  };
}

function formatSearchSummary(item: FinderSearchedItem) {
  const primary = item.query || item.scope || item.chatId || item.kind;
  const suffix = item.note ? `: ${item.note}` : '';

  return `${item.kind} -> ${primary}${suffix}`;
}

function buildExternalFinderResult(memory: FinderMemory, result?: FinderStepResponse['result']): FinderToolResult {
  return {
    ok: true,
    summary: result?.summary || 'Search completed with partial findings.',
    confidence: result?.confidence || 'low',
    evidence: memory.saved.slice(0, 8).map((item) => ({
      chatId: item.chatId,
      chatTitle: item.chatTitle,
      messageId: item.messageId,
      text: item.label || item.value,
      whyItMatters: item.label ? item.value : undefined,
    })),
    searchedSummary: memory.searched.slice(0, 8).map(formatSearchSummary),
    notFoundReason: result?.notFoundReason,
  };
}

function compactToolResultForFinder(result: unknown) {
  const raw = JSON.stringify(result) || 'null';

  if (!(result && typeof result === 'object' && !Array.isArray(result))) {
    return raw.length > 3500 ? `${raw.slice(0, 3500).trimEnd()}...` : raw;
  }

  const record = result as Record<string, unknown>;
  const list = Array.isArray(record.messages)
    ? record.messages
    : Array.isArray(record.results)
      ? record.results
      : Array.isArray(record.items)
        ? record.items
        : Array.isArray(record.surroundingMessages)
          ? record.surroundingMessages
          : undefined;

  if (!list) {
    return raw.length > 3500 ? `${raw.slice(0, 3500).trimEnd()}...` : raw;
  }

  const preview = list.slice(0, 8).map((item) => {
    if (!(item && typeof item === 'object' && !Array.isArray(item))) {
      return item;
    }

    const message = item as Record<string, unknown>;

    return Object.fromEntries(
      Object.entries({
        chatId: asOptionalString(message.chatId),
        chatTitle: truncateText(message.chatTitle, 80),
        messageId: asOptionalNumber(message.messageId),
        author: truncateText(message.author, 80),
        timestampText: truncateText(message.timestampText, 40),
        text: truncateText(message.text, 220),
        title: truncateText(message.title, 120),
        type: truncateText(message.type, 40),
      }).filter(([, value]) => value !== undefined),
    );
  });

  return JSON.stringify({
    resultCount: list.length,
    hasMore: record.hasMore === true,
    nextCursor: truncateText(record.nextCursor, 120),
    items: preview,
  });
}

function buildFinderUserPayload(input: FindInTelegramInput, memory: FinderMemory, freshToolResults: unknown[]) {
  return JSON.stringify({
    task: input,
    memory,
    freshToolResults,
  });
}

function parseFindInTelegramInput(args: unknown): FindInTelegramInput {
  const record = asRecord(args, 'find_in_telegram arguments');
  const goal = asOptionalString(record.goal);

  if (!goal) {
    throw new Error('goal is required.');
  }

  const depth = asOptionalString(record.depth);

  return {
    goal,
    scopeHint: asOptionalString(record.scopeHint),
    chatHint: asOptionalString(record.chatHint),
    dateFrom: asOptionalString(record.dateFrom),
    dateTo: asOptionalString(record.dateTo),
    depth: depth === 'quick' || depth === 'deep' || depth === 'normal'
      ? depth
      : undefined,
  };
}

export class FindInTelegramSubAgentTool {
  private dependencies: FinderToolDependencies;

  constructor(dependencies: FinderToolDependencies) {
    this.dependencies = dependencies;
  }

  toToolDefinition(): TeleAgentToolDefinition {
    return {
      name: FINDER_TOOL_NAME,
      description: [
        'Run a dedicated search sub-agent with its own compact memory.',
        'Use it when you need a deeper multi-step search over dialogs and messages',
        'without keeping all raw search results in your own context.',
        'Pass a concrete search goal and optional chat/date hints.',
      ].join(' '),
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['goal'],
        properties: {
          goal: { type: 'string', description: 'Concrete search task for the finder. Required.' },
          scopeHint: { type: 'string', description: 'Optional hint about where to search.' },
          chatHint: { type: 'string', description: 'Optional candidate chat name or identifier.' },
          dateFrom: { type: 'string', description: 'Optional lower date bound in YYYY-MM-DD format.' },
          dateTo: { type: 'string', description: 'Optional upper date bound in YYYY-MM-DD format.' },
          depth: { type: 'string', description: 'Optional depth: quick, normal, or deep.' },
        },
      },
      execute: async (args: unknown) => this.execute(args),
    };
  }

  private async execute(args: unknown): Promise<FinderToolResult> {
    const input = parseFindInTelegramInput(args);
    const maxIterations = getMaxIterations(input.depth);
    const toolsByName = new Map(this.dependencies.tools.map((tool) => [tool.name, tool]));
    let memory: FinderMemory = {
      searched: [],
      saved: [],
      next: [],
    };
    let freshToolResults: unknown[] = [];
    let lastResult: FinderStepResponse['result'];

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      const content = await requestPlainChatCompletion({
        apiBaseUrl: this.dependencies.apiBaseUrl,
        apiKey: this.dependencies.apiKey,
        model: this.dependencies.model,
        messages: [
          { role: 'system', content: FINDER_PROMPT },
          { role: 'user', content: buildFinderUserPayload(input, memory, freshToolResults) },
        ],
      });

      let parsedResponse: FinderStepResponse;
      try {
        parsedResponse = sanitizeFinderStepResponse(JSON.parse(stripCodeFences(content)));
      } catch (err) {
        if (iteration + 1 >= maxIterations) {
          throw new Error('Finder sub-agent returned invalid JSON.', { cause: err });
        }

        freshToolResults = [{
          tool: 'finder_runtime',
          error: 'Previous response was invalid JSON. Return valid JSON only.',
        }];
        continue;
      }

      memory = parsedResponse.memory;
      lastResult = parsedResponse.result;

      if (parsedResponse.status === 'finish') {
        return buildExternalFinderResult(memory, parsedResponse.result);
      }

      if (!parsedResponse.toolCalls.length) {
        return buildExternalFinderResult(memory, {
          summary: parsedResponse.result?.summary || 'Search stopped without additional tool calls.',
          confidence: parsedResponse.result?.confidence || 'low',
          notFoundReason: parsedResponse.result?.notFoundReason || 'Finder stopped before gathering enough evidence.',
        });
      }

      const nextFreshToolResults: unknown[] = [];

      for (const toolCall of parsedResponse.toolCalls) {
        const tool = toolsByName.get(toolCall.name);

        if (!tool) {
          nextFreshToolResults.push({
            tool: toolCall.name,
            error: 'Tool is not allowed for the finder sub-agent.',
          });
          continue;
        }

        try {
          const result = await tool.execute(toolCall.arguments);
          nextFreshToolResults.push({
            tool: toolCall.name,
            arguments: toolCall.arguments,
            result: compactToolResultForFinder(result),
          });
        } catch (err) {
          nextFreshToolResults.push({
            tool: toolCall.name,
            arguments: toolCall.arguments,
            error: err instanceof Error ? truncateText(err.message, 200) : 'Tool execution failed.',
          });
        }
      }

      freshToolResults = nextFreshToolResults;
    }

    return buildExternalFinderResult(memory, {
      summary: lastResult?.summary || 'Finder reached the iteration limit.',
      confidence: lastResult?.confidence || 'low',
      notFoundReason: lastResult?.notFoundReason || 'Finder reached its internal iteration limit before finishing.',
    });
  }
}
