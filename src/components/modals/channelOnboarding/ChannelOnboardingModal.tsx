import { memo } from '../../../lib/teact/teact';
import { getActions } from '../../../global';

import type { TabState } from '../../../global/types';

import { CHANNEL_ONBOARDING_CONFIG } from '../../../config/channelOnboarding';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import ConfirmDialog from '../../ui/ConfirmDialog';

export type OwnProps = {
  modal: TabState['channelOnboardingModal'];
};

const ChannelOnboardingModal = ({ modal }: OwnProps) => {
  const {
    closeChannelOnboardingModal,
    completeChannelOnboarding,
    openChatByUsername,
  } = getActions();
  const lang = useLang();

  const handleClose = useLastCallback(() => {
    closeChannelOnboardingModal(undefined);
    completeChannelOnboarding(undefined);
  });

  const handleConfirm = useLastCallback(() => {
    openChatByUsername({ username: CHANNEL_ONBOARDING_CONFIG.username });

    closeChannelOnboardingModal(undefined);
    completeChannelOnboarding(undefined);
  });

  return (
    <ConfirmDialog
      isOpen={Boolean(modal)}
      title={lang(CHANNEL_ONBOARDING_CONFIG.i18nKeys.title)}
      text={lang(CHANNEL_ONBOARDING_CONFIG.i18nKeys.text)}
      confirmLabel={lang(
        modal?.hasOpenedChannel
          ? CHANNEL_ONBOARDING_CONFIG.i18nKeys.primaryOpened
          : CHANNEL_ONBOARDING_CONFIG.i18nKeys.primary,
      )}
      cancelLabel={lang(CHANNEL_ONBOARDING_CONFIG.i18nKeys.secondary)}
      onClose={handleClose}
      confirmHandler={handleConfirm}
    />
  );
};

export default memo(ChannelOnboardingModal);
