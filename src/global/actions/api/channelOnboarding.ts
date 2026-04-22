import { addCallback } from '../../../lib/teact/teactn';

import type { ApiChat } from '../../../api/types';
import type { GlobalState } from '../../types';

import { CHANNEL_ONBOARDING_CONFIG } from '../../../config/channelOnboarding';
import { callApi } from '../../../api/gramjs';
import { getCurrentTabId } from '../../../util/establishMultitabRole';
import { addActionHandler, getActions, getGlobal } from '../../index';
import { selectChatByUsername, selectTabState } from '../../selectors';

const completedForSession = new Set<string>();
const inProgressForSession = new Set<string>();

addCallback((global: GlobalState) => {
  const tabId = getCurrentTabId();
  const tabState = selectTabState(global, tabId);
  const currentUserId = global.currentUserId;

  if (!CHANNEL_ONBOARDING_CONFIG.isEnabled
    || !tabState?.isMasterTab
    || tabState.uiReadyState !== 2
    || global.auth.state !== 'authorizationStateReady'
    || global.connectionState !== 'connectionStateReady'
    || !global.isSynced
    || !currentUserId
    || global.settings.byKey.channelOnboarding?.hasCompleted
    || completedForSession.has(currentUserId)
    || inProgressForSession.has(currentUserId)
    || tabState.channelOnboardingModal) {
    return;
  }

  getActions().runChannelOnboardingCheck({ tabId });
});

addActionHandler('runChannelOnboardingCheck', async (global, actions, payload): Promise<void> => {
  const { tabId = getCurrentTabId() } = payload || {};
  const currentUserId = global.currentUserId;

  if (!currentUserId || inProgressForSession.has(currentUserId) || completedForSession.has(currentUserId)) {
    return;
  }

  const latestGlobal = getGlobal();
  if (!CHANNEL_ONBOARDING_CONFIG.isEnabled
    || latestGlobal.settings.byKey.channelOnboarding?.hasCompleted
    || latestGlobal.auth.state !== 'authorizationStateReady'
    || latestGlobal.connectionState !== 'connectionStateReady'
    || !latestGlobal.isSynced
    || selectTabState(latestGlobal, tabId)?.uiReadyState !== 2) {
    return;
  }

  inProgressForSession.add(currentUserId);

  try {
    const chat = await resolveChannelChat();
    if (!chat) {
      actions.completeChannelOnboarding({ tabId });
      completedForSession.add(currentUserId);
      return;
    }

    if (chat.isNotJoined) {
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
    if (memberResult?.member) {
      actions.completeChannelOnboarding({ tabId });
      completedForSession.add(currentUserId);
      return;
    }

    if (CHANNEL_ONBOARDING_CONFIG.fallbackToOpenAndShowOnMembershipCheckFailure) {
      actions.openChatByUsername({ username: CHANNEL_ONBOARDING_CONFIG.username, tabId });
      actions.openChannelOnboardingModal({
        peerId: chat.id,
        hasOpenedChannel: true,
        tabId,
      });
    } else {
      actions.completeChannelOnboarding({ tabId });
    }

    completedForSession.add(currentUserId);
  } catch (err) {
    actions.completeChannelOnboarding({ tabId });
    completedForSession.add(currentUserId);
  } finally {
    inProgressForSession.delete(currentUserId);
  }
});

async function resolveChannelChat() {
  const currentGlobal = getGlobal();
  const localChat = selectChatByUsername(currentGlobal, CHANNEL_ONBOARDING_CONFIG.username);
  if (localChat && !localChat.isMin) {
    return localChat;
  }

  const result = await callApi('getChatByUsername', CHANNEL_ONBOARDING_CONFIG.username);
  if (!result?.chat) {
    return undefined;
  }

  return result.chat as ApiChat;
}
