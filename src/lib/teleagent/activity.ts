import type { TeleAgentAiActivityStep } from '../../types';

const PHASE_COMMENT_TAG_RE = /<phase_comment>([\s\S]*?)<\/phase_comment>/i;

const TOOL_STEP_LABELS: Record<string, string> = {
  list_dialogs: 'Получил список диалогов',
  search_dialogs: 'Нашёл подходящие диалоги',
  get_dialog_meta: 'Проверил детали диалога',
  read_dialog: 'Прочитал сообщения диалога',
  search_messages: 'Нашёл сообщения по запросу',
  get_message_context: 'Проверил контекст сообщения',
  get_unread_dialogs: 'Проверил непрочитанные диалоги',
  get_unread_messages: 'Прочитал непрочитанные сообщения',
  find_waiting_on_me: 'Проверил, где ждут ответа',
  extract_open_loops: 'Нашёл незакрытые вопросы и запросы',
};

function hasRawSyntax(value: string) {
  return /[{}[\]<>`]/.test(value)
    || /[A-Za-z]/.test(value)
    || /\b(json|tool|function|call|assistant|phase_comment)\b/i.test(value)
    || /[_/\\]/.test(value);
}

export function extractPhaseCommentTag(text: string) {
  const match = text.match(PHASE_COMMENT_TAG_RE);
  const phaseComment = match?.[1]?.trim();
  const cleanedText = text.replace(PHASE_COMMENT_TAG_RE, '').trim();

  return {
    phaseComment,
    text: cleanedText,
  };
}

export function validatePhaseComment(value?: string) {
  const normalized = value?.replace(/\s+/g, ' ').trim();

  if (!normalized || normalized.length > 60 || hasRawSyntax(normalized)) {
    return undefined;
  }

  const words = normalized.split(' ').filter(Boolean);
  if (words.length < 2 || words.length > 8) {
    return undefined;
  }

  if (!/[А-Яа-яЁё]/.test(normalized)) {
    return undefined;
  }

  return normalized;
}

export function getToolStepLabel(toolName: string) {
  return TOOL_STEP_LABELS[toolName] || 'Выполнил промежуточную проверку';
}

export function getFallbackHeadline(toolNames: string[]) {
  if (!toolNames.length) {
    return 'Готовлю ответ';
  }

  if (toolNames.some((name) => name === 'list_dialogs' || name === 'search_dialogs' || name === 'get_dialog_meta')) {
    return 'Смотрю диалоги';
  }

  if (toolNames.some((name) => name === 'search_messages')) {
    return 'Ищу сообщения';
  }

  if (toolNames.some((name) => name === 'read_dialog' || name === 'get_message_context')) {
    return 'Читаю контекст';
  }

  if (toolNames.some((name) => name === 'get_unread_dialogs'
    || name === 'get_unread_messages'
    || name === 'find_waiting_on_me'
    || name === 'extract_open_loops')) {
    return 'Анализирую важное';
  }

  return 'Готовлю ответ';
}

export function buildActivityStep(toolName: string, index: number): TeleAgentAiActivityStep {
  return {
    id: index,
    label: getToolStepLabel(toolName),
  };
}
