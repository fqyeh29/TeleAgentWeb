import type {
  TeleAgentAiActivity,
  TeleAgentAiError,
  TeleAgentAiMessage,
} from '../../../types';

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

function buildInitialActivity(current?: TeleAgentAiActivity): TeleAgentAiActivity {
  return {
    currentHeadline: 'Обдумываю ответ',
    steps: [],
    isExpanded: current?.isExpanded || false,
    status: 'running',
  };
}

function mergeActivityUpdate(
  current: ReturnType<typeof selectTabState>['teleAgentAi']['activity'],
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
      activity: undefined,
      lastCompletedActivity: undefined,
      isLastCompletedActivityVisible: false,
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
    activity: buildInitialActivity(current.activity),
    lastCompletedActivity: undefined,
    isLastCompletedActivityVisible: false,
    error: undefined,
    errorMessage: undefined,
  }));
  let lastActivitySnapshot: TeleAgentAiActivity | undefined;

  const result = await runTeleAgentAgentRuntime({
    apiBaseUrl: settings.apiBaseUrl,
    apiKey: settings.apiKey,
    model: settings.model,
    systemPrompt: settings.systemPrompt,
    messages: nextMessages,
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

  updateTeleAgentAiState(tabId, (current) => ({
    ...current,
    messages: result.text ? [...current.messages, buildMessage('assistant', result.text)] : current.messages,
    isLoading: false,
    activity: result.error ? current.activity : undefined,
    lastCompletedActivity: result.error ? current.lastCompletedActivity : lastActivitySnapshot,
    isLastCompletedActivityVisible: false,
    error: result.error,
    errorMessage: result.errorMessage,
  }));
});
