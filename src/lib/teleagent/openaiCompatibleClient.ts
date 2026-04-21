import type { TeleAgentAiError, TeleAgentAiMessage } from '../../types';

export const TELEAGENT_BUILT_IN_PROMPT = [
  'You are TeleAgent, an AI assistant embedded in TeleAgent.',
  'TeleAgent is a fork of Ajaxy/telegram-tt (Telegram Web A).',
  'Provide concise, helpful text-only answers.',
  'Do not claim to have tools, browsing, or external actions unless explicitly provided.',
].join('\n');

type OpenAiCompatibleRole = 'system' | TeleAgentAiMessage['role'];

type OpenAiCompatibleRequestMessage = {
  role: OpenAiCompatibleRole;
  content: string;
};

type OpenAiCompatibleMessageContent =
  | string
  | Array<{
    type?: string;
    text?: string;
  }>
  | undefined;

type OpenAiCompatibleResponse = {
  choices?: Array<{
    message?: {
      content?: OpenAiCompatibleMessageContent;
    };
  }>;
  error?: {
    message?: string;
  };
};

export type TeleAgentOpenAiCompatibleClientOptions = {
  apiBaseUrl: string;
  apiKey: string;
  model: string;
  systemPrompt?: string;
  messages: TeleAgentAiMessage[];
};

export type TeleAgentOpenAiCompatibleClientResult = {
  text?: string;
  error?: TeleAgentAiError;
};

function buildSystemPrompt(systemPrompt?: string) {
  const trimmedSystemPrompt = systemPrompt?.trim();

  return trimmedSystemPrompt
    ? `${TELEAGENT_BUILT_IN_PROMPT}\n\n${trimmedSystemPrompt}`
    : TELEAGENT_BUILT_IN_PROMPT;
}

function extractAssistantText(content: OpenAiCompatibleMessageContent) {
  if (typeof content === 'string') {
    return content.trim();
  }

  if (Array.isArray(content)) {
    const text = content
      .filter((part): part is { type?: string; text: string } => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text.trim())
      .filter(Boolean)
      .join('\n');

    return text.trim();
  }

  return '';
}

export async function sendTeleAgentOpenAiCompatibleRequest({
  apiBaseUrl,
  apiKey,
  model,
  systemPrompt,
  messages,
}: TeleAgentOpenAiCompatibleClientOptions): Promise<TeleAgentOpenAiCompatibleClientResult> {
  const normalizedBaseUrl = apiBaseUrl.trim().replace(/\/+$/, '');
  const payloadMessages: OpenAiCompatibleRequestMessage[] = [
    {
      role: 'system',
      content: buildSystemPrompt(systemPrompt),
    },
    ...messages.map((message) => ({
      role: message.role,
      content: message.text,
    })),
  ];

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
        messages: payloadMessages,
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
      };
    }

    return {
      error: 'server',
    };
  }

  const text = extractAssistantText(data?.choices?.[0]?.message?.content);

  if (!text) {
    return {
      error: 'badResponse',
    };
  }

  return {
    text,
  };
}
