import type { ActionReturnType } from '../../types';

import { getCurrentTabId } from '../../../util/establishMultitabRole';
import { addTabStateResetterAction } from '../../helpers/meta';
import { addActionHandler } from '../../index';
import { replaceSettings } from '../../reducers';
import { updateTabState } from '../../reducers/tabs';

addActionHandler('openChannelOnboardingModal', (global, actions, payload): ActionReturnType => {
  const { tabId = getCurrentTabId(), ...modal } = payload;

  return updateTabState(global, {
    channelOnboardingModal: modal,
  }, tabId);
});

addTabStateResetterAction('closeChannelOnboardingModal', 'channelOnboardingModal');

addActionHandler('completeChannelOnboarding', (global): ActionReturnType => {
  return replaceSettings(global, {
    channelOnboarding: {
      hasCompleted: true,
      checkedAt: Date.now(),
    },
  });
});
