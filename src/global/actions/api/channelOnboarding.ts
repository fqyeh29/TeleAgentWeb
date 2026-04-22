import { addCallback } from '../../../lib/teact/teactn';

import type { ApiChat } from '../../../api/types';
import type { GlobalState } from '../../types';

import { DEBUG } from '../../../config';
import { CHANNEL_ONBOARDING_CONFIG } from '../../../config/channelOnboarding';
import { callApi } from '../../../api/gramjs';
import { getCurrentTabId } from '../../../util/establishMultitabRole';
import { addActionHandler, getActions, getGlobal } from '../../index';
import { selectChatByUsername, selectTabState } from '../../selectors';

const completedForSession = new Set<string>();
const inProgressForSession = new Set<string>();

function logChannelOnboarding(message: string, details?: Record<string, unknown>) {
  if (!DEBUG) {
    return;
  }

  // eslint-disable-next-line no-console
  console.log('[channel-onboarding]', message, details || '');
}

addCallback((global: GlobalState) => {
  const tabId = getCurrentTabId();
  const tabState = selectTabState(global, tabId);
  const currentUserId = global.currentUserId;

  const skipReason = !CHANNEL_ONBOARDING_CONFIG.isEnabled ? 'feature-disabled'
    : !tabState ? 'tab-state-missing'
      : !tabState.isMasterTab ? 'not-master-tab'
        : tabState.uiReadyState !== 2 ? 'ui-not-ready'
          : global.auth.state !== 'authorizationStateReady' ? 'auth-not-ready'
            : global.connectionState !== 'connectionStateReady' ? 'connection-not-ready'
              : !global.isSynced ? 'not-synced'
                : !currentUserId ? 'current-user-missing'
                  : global.settings.byKey.channelOnboarding?.hasCompleted ? 'already-completed-persisted'
                    : completedForSession.has(currentUserId) ? 'already-completed-session'
                      : inProgressForSession.has(currentUserId) ? 'check-in-progress'
                        : tabState.channelOnboardingModal ? 'modal-already-open'
                          : undefined;

  if (skipReason) {
    logChannelOnboarding('skip addCallback gate', {
      skipReason,
      tabId,
      currentUserId,
      uiReadyState: tabState?.uiReadyState,
      isMasterTab: tabState?.isMasterTab,
      authState: global.auth.state,
      connectionState: global.connectionState,
      isSynced: global.isSynced,
      hasCompletedPersisted: global.settings.byKey.channelOnboarding?.hasCompleted,
    });
    return;
  }

  logChannelOnboarding('trigger runChannelOnboardingCheck', {
    tabId,
    currentUserId,
    username: CHANNEL_ONBOARDING_CONFIG.username,
  });
  getActions().runChannelOnboardingCheck({ tabId });
});

addActionHandler('runChannelOnboardingCheck', async (global, actions, payload): Promise<void> => {
  const { tabId = getCurrentTabId() } = payload || {};
  const currentUserId = global.currentUserId;

  if (!currentUserId || inProgressForSession.has(currentUserId) || completedForSession.has(currentUserId)) {
    logChannelOnboarding('skip action early', {
      tabId,
      currentUserId,
      inProgress: currentUserId ? inProgressForSession.has(currentUserId) : false,
      completedInSession: currentUserId ? completedForSession.has(currentUserId) : false,
    });
    return;
  }

  const latestGlobal = getGlobal();
  const latestTabState = selectTabState(latestGlobal, tabId);
  const skipReason = !CHANNEL_ONBOARDING_CONFIG.isEnabled ? 'feature-disabled'
    : latestGlobal.settings.byKey.channelOnboarding?.hasCompleted ? 'already-completed-persisted'
      : latestGlobal.auth.state !== 'authorizationStateReady' ? 'auth-not-ready'
        : latestGlobal.connectionState !== 'connectionStateReady' ? 'connection-not-ready'
          : !latestGlobal.isSynced ? 'not-synced'
            : latestTabState?.uiReadyState !== 2 ? 'ui-not-ready'
              : undefined;

  if (skipReason) {
    logChannelOnboarding('skip action gate', {
      skipReason,
      tabId,
      currentUserId,
      uiReadyState: latestTabState?.uiReadyState,
      authState: latestGlobal.auth.state,
      connectionState: latestGlobal.connectionState,
      isSynced: latestGlobal.isSynced,
      hasCompletedPersisted: latestGlobal.settings.byKey.channelOnboarding?.hasCompleted,
    });
    return;
  }

  inProgressForSession.add(currentUserId);
  logChannelOnboarding('start check', {
    tabId,
    currentUserId,
    username: CHANNEL_ONBOARDING_CONFIG.username,
  });

  try {
    const chat = await resolveChannelChat();
    logChannelOnboarding('resolveChannelChat result', {
      tabId,
      currentUserId,
      found: Boolean(chat),
      chatId: chat?.id,
      title: chat?.title,
      username: CHANNEL_ONBOARDING_CONFIG.username,
      isMin: chat?.isMin,
      isNotJoined: chat?.isNotJoined,
    });

    if (CHANNEL_ONBOARDING_CONFIG.debugForceShowModal) {
      logChannelOnboarding('debugForceShowModal enabled, opening modal immediately', {
        tabId,
        currentUserId,
        chatId: chat?.id,
        hasOpenedChannel: Boolean(chat),
      });
      if (chat) {
        actions.openChatByUsername({ username: CHANNEL_ONBOARDING_CONFIG.username, tabId });
      }
      actions.openChannelOnboardingModal({
        peerId: chat?.id,
        hasOpenedChannel: Boolean(chat),
        tabId,
      });
      completedForSession.add(currentUserId);
      return;
    }

    if (!chat) {
      logChannelOnboarding('complete silently because channel was not resolved', {
        tabId,
        currentUserId,
        username: CHANNEL_ONBOARDING_CONFIG.username,
      });
      actions.completeChannelOnboarding({ tabId });
      completedForSession.add(currentUserId);
      return;
    }

    if (chat.isNotJoined) {
      logChannelOnboarding('open channel and show modal because chat is not joined', {
        tabId,
        currentUserId,
        chatId: chat.id,
      });
      actions.openChatByUsername({ username: CHANNEL_ONBOARDING_CONFIG.username, tabId });
      actions.openChannelOnboardingModal({
        peerId: chat.id,
        hasOpenedChannel: true,
        tabId,
      });
      completedForSession.add(currentUserId);
      return;
    }

    const memberResult = await callApi('fetchMember', { chat });
    logChannelOnboarding('fetchMember result', {
      tabId,
      currentUserId,
      chatId: chat.id,
      hasMember: Boolean(memberResult?.member),
    });

    if (memberResult?.member) {
      logChannelOnboarding('complete silently because current user is already a member', {
        tabId,
        currentUserId,
        chatId: chat.id,
      });
      actions.completeChannelOnboarding({ tabId });
      completedForSession.add(currentUserId);
      return;
    }

    if (CHANNEL_ONBOARDING_CONFIG.fallbackToOpenAndShowOnMembershipCheckFailure) {
      logChannelOnboarding('open channel and show modal via fallback after membership check', {
        tabId,
        currentUserId,
        chatId: chat.id,
      });
      actions.openChatByUsername({ username: CHANNEL_ONBOARDING_CONFIG.username, tabId });
      actions.openChannelOnboardingModal({
        peerId: chat.id,
        hasOpenedChannel: true,
        tabId,
      });
    } else {
      logChannelOnboarding('complete silently because fallback is disabled', {
        tabId,
        currentUserId,
        chatId: chat.id,
      });
      actions.completeChannelOnboarding({ tabId });
    }

    completedForSession.add(currentUserId);
  } catch (err) {
    logChannelOnboarding('complete silently because check failed with error', {
      tabId,
      currentUserId,
      error: err instanceof Error ? err.message : String(err),
    });
    actions.completeChannelOnboarding({ tabId });
    completedForSession.add(currentUserId);
  } finally {
    inProgressForSession.delete(currentUserId);
    logChannelOnboarding('finish check', {
      tabId,
      currentUserId,
      completedInSession: completedForSession.has(currentUserId),
    });
  }
});

async function resolveChannelChat() {
  const currentGlobal = getGlobal();
  const localChat = selectChatByUsername(currentGlobal, CHANNEL_ONBOARDING_CONFIG.username);
  if (localChat && !localChat.isMin) {
    logChannelOnboarding('resolveChannelChat used local cached chat', {
      chatId: localChat.id,
      title: localChat.title,
      isNotJoined: localChat.isNotJoined,
    });
    return localChat;
  }

  logChannelOnboarding('resolveChannelChat requesting API lookup', {
    username: CHANNEL_ONBOARDING_CONFIG.username,
    hadLocalChat: Boolean(localChat),
    localChatIsMin: localChat?.isMin,
  });
  const result = await callApi('getChatByUsername', CHANNEL_ONBOARDING_CONFIG.username);
  if (!result?.chat) {
    logChannelOnboarding('resolveChannelChat API lookup returned no chat', {
      username: CHANNEL_ONBOARDING_CONFIG.username,
    });
    return undefined;
  }

  logChannelOnboarding('resolveChannelChat API lookup succeeded', {
    chatId: result.chat.id,
    title: result.chat.title,
    isNotJoined: result.chat.isNotJoined,
  });
  return result.chat as ApiChat;
}
