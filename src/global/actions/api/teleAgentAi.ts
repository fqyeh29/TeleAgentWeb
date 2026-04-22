import type {
  TeleAgentAiActivity,
  TeleAgentAiError,
  TeleAgentAiHistory,
  TeleAgentAiMessage,
  TeleAgentAiPersistedChat,
  TeleAgentAiPersistedMessage,
} from '../../../types';
import type { ActionReturnType } from '../../types';

import { runTeleAgentAgentRuntime } from '../../../lib/teleagent/agentRuntime';
import { getCurrentTabId } from '../../../util/establishMultitabRole';
import generateUniqueId from '../../../util/generateUniqueId';
import { addActionHandler, getGlobal, setGlobal } from '../../index';
import { updateTabState } from '../../reducers/tabs';
import { selectTabState } from '../../selectors';
import { selectTeleAgentAiSettings } from '../../selectors/settings';

type TeleAgentAiTabState = ReturnType<typeof selectTabState>['teleAgentAi'];

const TELE_AGENT_AI_TITLE_LIMIT = 40;

function updateTeleAgentAiState(
  tabId: number,
  updater: (current: TeleAgentAiTabState) => TeleAgentAiTabState,
) {
  let global = getGlobal();
  const tabState = selectTabState(global, tabId);

  global = updateTabState(global, {
    teleAgentAi: updater(tabState.teleAgentAi),
  }, tabId);

  setGlobal(global);
}

function buildMessage(role: TeleAgentAiMessage['role'], text: string): TeleAgentAiPersistedMessage {
  return {
    id: Date.now() + Math.floor(Math.random() * 1000),
    role,
    text,
    timestamp: Date.now(),
  };
}

function buildInitialActivity(current?: TeleAgentAiActivity): TeleAgentAiActivity {
  return {
    currentHeadline: 'РћР±РґСѓРјС‹РІР°СЋ РѕС‚РІРµС‚',
    steps: [],
    isExpanded: current?.isExpanded || false,
    status: 'running',
  };
}

function mergeActivityUpdate(
  current: TeleAgentAiTabState['activity'],
  update?: {
    headline?: string;
    step?: {
      label: string;
    };
    status?: 'running' | 'error';
    errorText?: string;
    currentPhase?: string;
  },
) {
  if (!update) {
    return undefined;
  }

  const base = current || buildInitialActivity();
  const nextStep = update.step ? {
    id: base.steps.length + 1,
    label: update.step.label,
  } : undefined;

  return {
    ...base,
    currentHeadline: update.headline || base.currentHeadline,
    steps: nextStep ? [...base.steps, nextStep] : base.steps,
    status: update.status || base.status,
    currentPhase: update.currentPhase || base.currentPhase,
    errorText: update.errorText,
  };
}

function validateConfig(settings: ReturnType<typeof selectTeleAgentAiSettings>): TeleAgentAiError | undefined {
  if (!settings.isEnabled) {
    return 'disabled';
  }

  if (!settings.apiBaseUrl.trim()) {
    return 'missingBaseUrl';
  }

  if (!settings.apiKey.trim()) {
    return 'missingApiKey';
  }

  if (!/^[\x20-\x7E]+$/.test(settings.apiKey.trim())) {
    return 'invalidApiKey';
  }

  if (!settings.model.trim()) {
    return 'missingModel';
  }

  return undefined;
}

function buildRuntimeReset(current: TeleAgentAiTabState, messages: TeleAgentAiMessage[] = []): TeleAgentAiTabState {
  return {
    ...current,
    messages,
    isLoading: false,
    activity: undefined,
    lastCompletedActivity: undefined,
    isLastCompletedActivityVisible: false,
    error: undefined,
    errorMessage: undefined,
  };
}

function normalizeTeleAgentAiChatTitle(text: string) {
  const normalized = text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?,;:)\]]+$/g, '');

  if (!normalized) {
    return 'New chat';
  }

  return normalized.length > TELE_AGENT_AI_TITLE_LIMIT
    ? `${normalized.slice(0, TELE_AGENT_AI_TITLE_LIMIT).trimEnd()}...`
    : normalized;
}

function sortTeleAgentAiChatIds(byId: TeleAgentAiHistory['byId']) {
  return Object.values(byId)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((chat) => chat.id);
}

function createTeleAgentAiChat(firstMessage: TeleAgentAiPersistedMessage): TeleAgentAiPersistedChat {
  return {
    id: generateUniqueId(),
    title: normalizeTeleAgentAiChatTitle(firstMessage.text),
    createdAt: firstMessage.timestamp,
    updatedAt: firstMessage.timestamp,
    messages: [firstMessage],
  };
}

function appendTeleAgentAiMessage(
  history: TeleAgentAiHistory,
  chatId: string,
  message: TeleAgentAiPersistedMessage,
): TeleAgentAiHistory {
  const chat = history.byId[chatId];

  if (!chat) {
    return history;
  }

  const updatedChat: TeleAgentAiPersistedChat = {
    ...chat,
    updatedAt: message.timestamp,
    messages: [...chat.messages, message],
  };

  const byId = {
    ...history.byId,
    [chatId]: updatedChat,
  };

  return {
    ...history,
    byId,
    chatIds: sortTeleAgentAiChatIds(byId),
  };
}

function getActiveChatMessages(history: TeleAgentAiHistory): TeleAgentAiPersistedMessage[] {
  return history.activeChatId ? (history.byId[history.activeChatId]?.messages || []) : [];
}

function setActiveTeleAgentAiChat<T extends { teleAgentAiHistory: TeleAgentAiHistory }>(global: T, chatId?: string): T {
  return {
    ...global,
    teleAgentAiHistory: {
      ...global.teleAgentAiHistory,
      activeChatId: chatId,
    },
  };
}

addActionHandler('openTeleAgentAiChat', (global, actions, payload): ActionReturnType => {
  const { chatId, tabId = getCurrentTabId() } = payload;
  const chat = global.teleAgentAiHistory.byId[chatId];

  if (!chat) {
    return undefined;
  }

  return updateTabState(setActiveTeleAgentAiChat(global, chatId), {
    teleAgentAi: buildRuntimeReset(selectTabState(global, tabId).teleAgentAi, chat.messages),
  }, tabId);
});

addActionHandler('closeTeleAgentAiChat', (global, actions, payload): ActionReturnType => {
  const tabId = payload?.tabId ?? getCurrentTabId();

  return updateTabState(setActiveTeleAgentAiChat(global, undefined), {
    teleAgentAi: buildRuntimeReset(selectTabState(global, tabId).teleAgentAi),
  }, tabId);
});

addActionHandler('deleteTeleAgentAiChat', (global, actions, payload): ActionReturnType => {
  const { chatId, tabId = getCurrentTabId() } = payload;

  if (!global.teleAgentAiHistory.byId[chatId]) {
    return undefined;
  }

  const byId = { ...global.teleAgentAiHistory.byId };
  delete byId[chatId];

  const nextGlobal = {
    ...global,
    teleAgentAiHistory: {
      activeChatId: global.teleAgentAiHistory.activeChatId === chatId
        ? undefined
        : global.teleAgentAiHistory.activeChatId,
      byId,
      chatIds: sortTeleAgentAiChatIds(byId),
    },
  };

  if (global.teleAgentAiHistory.activeChatId !== chatId) {
    return nextGlobal;
  }

  return updateTabState(nextGlobal, {
    teleAgentAi: buildRuntimeReset(selectTabState(global, tabId).teleAgentAi),
  }, tabId);
});

addActionHandler('sendTeleAgentAiMessage', async (currentGlobal, actions, payload): Promise<void> => {
  const { text, tabId = getCurrentTabId() } = payload;
  const trimmedText = text.trim();

  if (!trimmedText) {
    return;
  }

  const tabState = selectTabState(currentGlobal, tabId);

  if (tabState.teleAgentAi.isLoading) {
    return;
  }

  const userMessage = buildMessage('user', trimmedText);
  let global = getGlobal();
  let nextHistory = global.teleAgentAiHistory;
  let activeChatId = nextHistory.activeChatId;

  if (!activeChatId || !nextHistory.byId[activeChatId]) {
    const chat = createTeleAgentAiChat(userMessage);
    const byId = {
      ...nextHistory.byId,
      [chat.id]: chat,
    };

    nextHistory = {
      activeChatId: chat.id,
      byId,
      chatIds: sortTeleAgentAiChatIds(byId),
    };
    activeChatId = chat.id;
  } else {
    nextHistory = appendTeleAgentAiMessage(nextHistory, activeChatId, userMessage);
  }

  global = updateTabState({
    ...global,
    teleAgentAiHistory: nextHistory,
  }, {
    teleAgentAi: {
      ...tabState.teleAgentAi,
      messages: getActiveChatMessages(nextHistory),
      isLoading: true,
      activity: buildInitialActivity(tabState.teleAgentAi.activity),
      lastCompletedActivity: undefined,
      isLastCompletedActivityVisible: false,
      error: undefined,
      errorMessage: undefined,
    },
  }, tabId);

  setGlobal(global);

  const settings = selectTeleAgentAiSettings(global);
  const validationError = validateConfig(settings);

  if (validationError) {
    updateTeleAgentAiState(tabId, (current) => ({
      ...current,
      isLoading: false,
      activity: undefined,
      lastCompletedActivity: undefined,
      isLastCompletedActivityVisible: false,
      error: validationError,
      errorMessage: undefined,
    }));
    return;
  }

  const runtimeMessages = global.teleAgentAiHistory.byId[activeChatId].messages;
  let lastActivitySnapshot: TeleAgentAiActivity | undefined;

  const result = await runTeleAgentAgentRuntime({
    apiBaseUrl: settings.apiBaseUrl,
    apiKey: settings.apiKey,
    model: settings.model,
    systemPrompt: settings.systemPrompt,
    messages: runtimeMessages,
    onActivity: (activityUpdate) => {
      updateTeleAgentAiState(tabId, (current) => {
        const nextActivity = mergeActivityUpdate(current.activity, activityUpdate);

        if (activityUpdate) {
          lastActivitySnapshot = nextActivity;
        }

        return {
          ...current,
          activity: nextActivity,
        };
      });
    },
  });

  global = getGlobal();
  let finalMessages = getActiveChatMessages(global.teleAgentAiHistory);

  if (result.text && global.teleAgentAiHistory.byId[activeChatId]) {
    global = {
      ...global,
      teleAgentAiHistory: appendTeleAgentAiMessage(
        global.teleAgentAiHistory,
        activeChatId,
        buildMessage('assistant', result.text),
      ),
    };
    finalMessages = getActiveChatMessages(global.teleAgentAiHistory);
  }

  global = updateTabState(global, {
    teleAgentAi: {
      ...selectTabState(global, tabId).teleAgentAi,
      messages: finalMessages,
      isLoading: false,
      activity: result.error ? selectTabState(global, tabId).teleAgentAi.activity : undefined,
      lastCompletedActivity: result.error
        ? selectTabState(global, tabId).teleAgentAi.lastCompletedActivity
        : lastActivitySnapshot,
      isLastCompletedActivityVisible: false,
      error: result.error,
      errorMessage: result.errorMessage,
    },
  }, tabId);

  setGlobal(global);
});
