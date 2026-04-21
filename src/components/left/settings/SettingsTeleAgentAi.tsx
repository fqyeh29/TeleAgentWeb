import type { FC } from '../../../lib/teact/teact';
import { memo } from '../../../lib/teact/teact';
import { getActions, withGlobal } from '../../../global';

import { pick } from '../../../util/iteratees';

import useHistoryBack from '../../../hooks/useHistoryBack';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Checkbox from '../../ui/Checkbox';
import InputText from '../../ui/InputText';
import TextArea from '../../ui/TextArea';

type OwnProps = {
  isActive?: boolean;
  onReset: () => void;
};

type StateProps = {
  teleAgentAiEnabled: boolean;
  teleAgentAiApiBaseUrl: string;
  teleAgentAiApiKey: string;
  teleAgentAiModel: string;
  teleAgentAiSystemPrompt: string;
};

const SettingsTeleAgentAi: FC<OwnProps & StateProps> = ({
  isActive,
  teleAgentAiEnabled,
  teleAgentAiApiBaseUrl,
  teleAgentAiApiKey,
  teleAgentAiModel,
  teleAgentAiSystemPrompt,
  onReset,
}) => {
  const { setSettingOption } = getActions();
  const lang = useLang();

  useHistoryBack({
    isActive,
    onBack: onReset,
  });

  const handleToggleEnabled = useLastCallback((isChecked: boolean) => {
    setSettingOption({ teleAgentAiEnabled: isChecked });
  });

  const handleApiBaseUrlChange = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setSettingOption({ teleAgentAiApiBaseUrl: e.target.value });
  });

  const handleApiKeyChange = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setSettingOption({ teleAgentAiApiKey: e.target.value });
  });

  const handleModelChange = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setSettingOption({ teleAgentAiModel: e.target.value });
  });

  const handleSystemPromptChange = useLastCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setSettingOption({ teleAgentAiSystemPrompt: e.target.value });
  });

  return (
    <div className="settings-content custom-scroll">
      <div className="settings-item">
        <h4 className="settings-item-header" dir={lang.isRtl ? 'rtl' : undefined}>
          {lang('TeleAgentAISettingsTitle')}
        </h4>
        <p className="settings-item-description" dir={lang.isRtl ? 'rtl' : undefined}>
          {lang('TeleAgentAISettingsDescription')}
        </p>

        <Checkbox
          label={lang('TeleAgentAIEnable')}
          checked={teleAgentAiEnabled}
          onCheck={handleToggleEnabled}
        />
      </div>

      <div className="settings-item">
        <div className="settings-input">
          <InputText
            value={teleAgentAiApiBaseUrl}
            onChange={handleApiBaseUrlChange}
            label={lang('TeleAgentAIBaseUrl')}
            inputMode="url"
            autoComplete="url"
          />
          <InputText
            value={teleAgentAiApiKey}
            onChange={handleApiKeyChange}
            label={lang('TeleAgentAIApiKey')}
            type="password"
            autoComplete="new-password"
          />
          <InputText
            value={teleAgentAiModel}
            onChange={handleModelChange}
            label={lang('TeleAgentAIModel')}
          />
          <TextArea
            className="settings-teleagent-system-prompt"
            value={teleAgentAiSystemPrompt}
            onChange={handleSystemPromptChange}
            label={lang('TeleAgentAISystemPrompt')}
            noReplaceNewlines
          />
        </div>
      </div>
    </div>
  );
};

export default memo(withGlobal<OwnProps>(
  (global): StateProps => pick(global.settings.byKey, [
    'teleAgentAiEnabled',
    'teleAgentAiApiBaseUrl',
    'teleAgentAiApiKey',
    'teleAgentAiModel',
    'teleAgentAiSystemPrompt',
  ]),
)(SettingsTeleAgentAi));
