export const CHANNEL_ONBOARDING_CONFIG = {
  isEnabled: true,
  username: 'teleagent_app',
  displayName: '@teleagent_app',
  fallbackToOpenAndShowOnMembershipCheckFailure: true,
  i18nKeys: {
    title: 'ChannelOnboardingTitle',
    text: 'ChannelOnboardingText',
    primary: 'ChannelOnboardingPrimary',
    primaryOpened: 'ChannelOnboardingPrimaryOpened',
    secondary: 'ChannelOnboardingSecondary',
  },
} as const;
