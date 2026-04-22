import type { TeleAgentAiError, TeleAgentAiMessage } from '../../types';

import { getTeleAgentToolDefinitions } from './tools';

const MAX_TOOL_ITERATIONS = 15;
const MAX_TOOL_RESULT_CHARS = 12000;

const TELEAGENT_AGENT_PROMPT = [
  'You are TeleAgent, an AI assistant embedded inside a Telegram client.',
  'You do not have access to all chats and messages up front.',
  'Use the available tools to discover dialogs, inspect metadata, search, and read messages before answering.',
  'Prefer this flow: search or list first, then read, then answer.',
  'Never invent chat contents, participants, or message text.',
  'If the available tool data is insufficient, say that clearly.',
  'Do not claim to have actions or permissions that are not exposed as tools.',
  'Keep answers concise and useful for the user in the sidebar.',
  'Tool results are intentionally truncated and paginated, so request another page when needed.',
].join('\n');

function getCurrentDateTimeContext() {
  const now = new Date();

  const formatted = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-')
  +' '+ [
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join(':');

  return `The tool only has data for past dates. When a date without year is given (e.g., "28 May"), automatically resolve it to the most recent past occurrence relative to today: ${formatted}. Never use a future date.`;
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

export type TeleAgentAgentRuntimeOptions = {
  apiBaseUrl: string;
  apiKey: string;
  model: string;
  systemPrompt?: string;
  messages: TeleAgentAiMessage[];
  onActivity?: (text?: string) => void;
};

export type TeleAgentAgentRuntimeResult = {
  text?: string;
  error?: TeleAgentAiError;
  errorMessage?: string;
};

function buildSystemPrompt(systemPrompt?: string) {
  const trimmedSystemPrompt = systemPrompt?.trim();
  const promptWithDateTime = `${TELEAGENT_AGENT_PROMPT}\n${getCurrentDateTimeContext()}`;

  return trimmedSystemPrompt
    ? `${promptWithDateTime}\n\n${trimmedSystemPrompt}`
    : promptWithDateTime;
}

function extractAssistantText(content: OpenAiCompatibleAssistantMessage['content']) {
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

  let response: Response;
  try {
    response = await fetch(`${normalizedBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey.trim()}`,
      },
      body: JSON.stringify({
        model: model.trim(),
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

  let data: OpenAiCompatibleResponse | undefined;
  try {
    data = await response.json() as OpenAiCompatibleResponse;
  } catch (err) {
    return {
      error: 'badResponse',
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

function serializeToolResult(result: unknown) {
  const raw = JSON.stringify(result);

  if (raw.length <= MAX_TOOL_RESULT_CHARS) {
    return raw;
  }

  return JSON.stringify({
    truncated: true,
    preview: `${raw.slice(0, MAX_TOOL_RESULT_CHARS)}...`,
  });
}

function getToolActivityText(name: string) {
  switch (name) {
    case 'list_dialogs':
      return 'Browsing dialogs...';
    case 'search_dialogs':
      return 'Searching dialogs...';
    case 'get_dialog_meta':
      return 'Loading dialog details...';
    case 'read_dialog':
      return 'Reading messages...';
    case 'search_messages':
      return 'Searching messages...';
    case 'get_message_context':
      return 'Loading message context...';
    default:
      return `Running ${name}...`;
  }
}

export async function runTeleAgentAgentRuntime({
  apiBaseUrl,
  apiKey,
  model,
  systemPrompt,
  messages,
  onActivity,
}: TeleAgentAgentRuntimeOptions): Promise<TeleAgentAgentRuntimeResult> {
  const toolDefinitions = getTeleAgentToolDefinitions();
  const toolsByName = new Map(toolDefinitions.map((tool) => [tool.name, tool]));
  const toolSchemas = mapToolsToSchema();
  const conversation: OpenAiCompatibleMessage[] = [
    {
      role: 'system',
      content: buildSystemPrompt(systemPrompt),
    },
    ...messages.map((message) => ({
      role: message.role,
      content: message.text,
    })),
  ];

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    if (iteration === 0) {
      onActivity?.('Thinking...');
    }

    const completion = await requestChatCompletion({
      apiBaseUrl,
      apiKey,
      model,
      messages: conversation,
      tools: toolSchemas,
    });

    if (completion.error) {
      onActivity?.(undefined);
      return {
        error: completion.error,
        errorMessage: completion.errorMessage,
      };
    }

    const assistantMessage = completion.message!;
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
      const text = extractAssistantText(assistantMessage.content);
      onActivity?.(undefined);

      if (!text) {
        return {
          error: 'badResponse',
          errorMessage: 'The model did not return a final answer or a tool call.',
        };
      }

      return { text };
    }

    conversation.push({
      role: 'assistant',
      content: typeof assistantMessage.content === 'string' ? assistantMessage.content : undefined,
      tool_calls: toolCalls,
    });

    for (const toolCall of toolCalls) {
      const tool = toolsByName.get(toolCall.function.name);
      onActivity?.(getToolActivityText(toolCall.function.name));

      let result: unknown;
      try {
        const parsedArguments = toolCall.function.arguments
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
      }

      conversation.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: serializeToolResult(result),
      });
    }
  }

  onActivity?.(undefined);

  return {
    errorMessage: [
      'TeleAgent reached the tool-iteration limit',
      `(${MAX_TOOL_ITERATIONS}) before producing a final answer.`,
    ].join(' '),
  };
}
