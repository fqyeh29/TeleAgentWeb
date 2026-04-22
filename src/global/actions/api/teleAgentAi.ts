import type { TeleAgentAiError, TeleAgentAiMessage } from '../../../types';

import { runTeleAgentAgentRuntime } from '../../../lib/teleagent/agentRuntime';
import { getCurrentTabId } from '../../../util/establishMultitabRole';
import { addActionHandler, getGlobal, setGlobal } from '../../index';
import { updateTabState } from '../../reducers/tabs';
import { selectTabState } from '../../selectors';
import { selectTeleAgentAiSettings } from '../../selectors/settings';

function updateTeleAgentAiState(
  tabId: number,
  updater: (
    current: ReturnType<typeof selectTabState>['teleAgentAi'],
  ) => ReturnType<typeof selectTabState>['teleAgentAi'],
) {
  let global = getGlobal();
  const tabState = selectTabState(global, tabId);

  global = updateTabState(global, {
    teleAgentAi: updater(tabState.teleAgentAi),
  }, tabId);

  setGlobal(global);
}

function buildMessage(role: TeleAgentAiMessage['role'], text: string): TeleAgentAiMessage {
  return {
    id: Date.now() + Math.floor(Math.random() * 1000),
    role,
    text,
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

  if (!settings.model.trim()) {
    return 'missingModel';
  }

  return undefined;
}

addActionHandler('sendTeleAgentAiMessage', async (global, actions, payload): Promise<void> => {
  const { text, tabId = getCurrentTabId() } = payload;
  const trimmedText = text.trim();

  if (!trimmedText) {
    return;
  }

  const tabState = selectTabState(global, tabId);

  if (tabState.teleAgentAi.isLoading) {
    return;
  }

  const settings = selectTeleAgentAiSettings(global);
  const validationError = validateConfig(settings);

  if (validationError) {
    updateTeleAgentAiState(tabId, (current) => ({
      ...current,
      activityText: undefined,
      error: validationError,
      errorMessage: undefined,
    }));
    return;
  }

  const nextMessages = [
    ...tabState.teleAgentAi.messages,
    buildMessage('user', trimmedText),
  ];

  updateTeleAgentAiState(tabId, (current) => ({
    ...current,
    messages: nextMessages,
    isLoading: true,
    activityText: 'Thinking...',
    error: undefined,
    errorMessage: undefined,
  }));

  const result = await runTeleAgentAgentRuntime({
    apiBaseUrl: settings.apiBaseUrl,
    apiKey: settings.apiKey,
    model: settings.model,
    systemPrompt: settings.systemPrompt,
    messages: nextMessages,
    onActivity: (activityText) => {
      updateTeleAgentAiState(tabId, (current) => ({
        ...current,
        activityText,
      }));
    },
  });

  updateTeleAgentAiState(tabId, (current) => ({
    ...current,
    messages: result.text ? [...current.messages, buildMessage('assistant', result.text)] : current.messages,
    isLoading: false,
    activityText: undefined,
    error: result.error,
    errorMessage: result.errorMessage,
  }));
});
