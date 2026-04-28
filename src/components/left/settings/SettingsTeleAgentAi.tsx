import type { FC } from '../../../lib/teact/teact';
import { memo } from '../../../lib/teact/teact';
import { getActions, withGlobal } from '../../../global';

import type { TeleAgentAiCompactionMode, TeleAgentAiDepth } from '../../../types';

import { pick } from '../../../util/iteratees';

import useHistoryBack from '../../../hooks/useHistoryBack';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Checkbox from '../../ui/Checkbox';
import InputText from '../../ui/InputText';
import RadioGroup from '../../ui/RadioGroup';
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
  teleAgentAiDefaultDepth: TeleAgentAiDepth;
  teleAgentAiMaxToolIterations: number;
  teleAgentAiCompactionMode: TeleAgentAiCompactionMode;
  teleAgentAiWorkspaceContext: string;
};

const DEPTH_OPTIONS = [
  {
    value: 'quick',
    label: 'Быстро',
    subLabel: 'Минимум шагов и короткие ответы. Хорошо для простых вопросов.',
  },
  {
    value: 'normal',
    label: 'Нормально',
    subLabel: 'Сбалансированный режим: проверяет достаточно, но не копает без нужды.',
  },
  {
    value: 'deep',
    label: 'Глубоко',
    subLabel: 'Подходит для расследований, сравнений и поиска по длинным обсуждениям.',
  },
] as const;

const COMPACTION_OPTIONS = [
  {
    value: 'fuller',
    label: 'Больше контекста',
    subLabel: 'Модель видит больше текста, но шанс переполнить контекст выше.',
  },
  {
    value: 'balanced',
    label: 'Сбалансировано',
    subLabel: 'Оптимальный режим по умолчанию.',
  },
  {
    value: 'aggressive',
    label: 'Жесткая компактизация',
    subLabel: 'Сильнее ужимает tool results. Полезно для слабых моделей и длинных поисков.',
  },
] as const;

const SettingsTeleAgentAi: FC<OwnProps & StateProps> = ({
  isActive,
  teleAgentAiEnabled,
  teleAgentAiApiBaseUrl,
  teleAgentAiApiKey,
  teleAgentAiModel,
  teleAgentAiSystemPrompt,
  teleAgentAiDefaultDepth,
  teleAgentAiMaxToolIterations,
  teleAgentAiCompactionMode,
  teleAgentAiWorkspaceContext,
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

  const handleWorkspaceContextChange = useLastCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setSettingOption({ teleAgentAiWorkspaceContext: e.target.value });
  });

  const handleMaxToolIterationsChange = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const value = Number(e.target.value.replace(/[^\d]/g, ''));
    setSettingOption({
      teleAgentAiMaxToolIterations: Number.isFinite(value) && value > 0 ? value : 15,
    });
  });

  const handleDepthChange = useLastCallback((value: string) => {
    setSettingOption({ teleAgentAiDefaultDepth: value as TeleAgentAiDepth });
  });

  const handleCompactionModeChange = useLastCallback((value: string) => {
    setSettingOption({ teleAgentAiCompactionMode: value as TeleAgentAiCompactionMode });
  });

  return (
    <div className="settings-content custom-scroll">
      <div className="settings-item">
        <h4 className="settings-item-header" dir={lang.isRtl ? 'rtl' : undefined}>
          Настройки TeleAgent AI
        </h4>
        <p className="settings-item-description" dir={lang.isRtl ? 'rtl' : undefined}>
          Здесь настраивается провайдер AI и то, как глубоко агент ищет, сколько шагов делает и
          насколько сильно ужимает результаты инструментов перед отправкой в модель.
        </p>

        <Checkbox
          label="Включить TeleAgent AI"
          checked={teleAgentAiEnabled}
          onCheck={handleToggleEnabled}
        />
      </div>

      <div className="settings-item">
        <h4 className="settings-item-header">Подключение</h4>
        <div className="settings-input">
          <InputText
            value={teleAgentAiApiBaseUrl}
            onChange={handleApiBaseUrlChange}
            label="API Base URL"
            inputMode="url"
            autoComplete="url"
          />
          <InputText
            value={teleAgentAiApiKey}
            onChange={handleApiKeyChange}
            label="API Key"
            type="password"
            autoComplete="new-password"
          />
          <InputText
            value={teleAgentAiModel}
            onChange={handleModelChange}
            label="Модель"
          />
        </div>
      </div>

      <div className="settings-item">
        <h4 className="settings-item-header">Поведение агента</h4>
        <p className="settings-item-description">
          Глубина влияет на то, насколько охотно агент будет продолжать поиск вместо быстрого ответа.
        </p>
        <RadioGroup
          name="teleagent-ai-depth"
          options={DEPTH_OPTIONS.slice()}
          selected={teleAgentAiDefaultDepth}
          onChange={handleDepthChange}
        />
      </div>

      <div className="settings-item">
        <div className="settings-input">
          <InputText
            value={String(teleAgentAiMaxToolIterations || 15)}
            onChange={handleMaxToolIterationsChange}
            label="Лимит шагов агента"
            inputMode="numeric"
          />
        </div>
        <p className="settings-item-description">
          Сколько вызовов инструментов агент может сделать до остановки. Для длинных расследований
          обычно подходят значения 12-20.
        </p>
      </div>

      <div className="settings-item">
        <h4 className="settings-item-header">Компактизация контекста</h4>
        <p className="settings-item-description">
          Чем жестче компактизация, тем ниже риск переполнить контекст, но модель видит меньше деталей.
        </p>
        <RadioGroup
          name="teleagent-ai-compaction"
          options={COMPACTION_OPTIONS.slice()}
          selected={teleAgentAiCompactionMode}
          onChange={handleCompactionModeChange}
        />
      </div>

      <div className="settings-item">
        <h4 className="settings-item-header">Контекст команды / проекта</h4>
        <p className="settings-item-description">
          Полезно указать название рабочей папки, проекта, команды или другие постоянные вводные.
          Это лучше, чем каждый раз дублировать их в сообщениях.
        </p>
        <TextArea
          className="settings-teleagent-system-prompt"
          value={teleAgentAiWorkspaceContext}
          onChange={handleWorkspaceContextChange}
          label="Рабочий контекст"
          noReplaceNewlines
        />
      </div>

      <div className="settings-item">
        <h4 className="settings-item-header">Дополнительный системный prompt</h4>
        <p className="settings-item-description">
          Сюда стоит писать только стабильные правила и доменные ограничения. Для разовых задач лучше
          формулировать запрос в чате, а не переписывать этот блок.
        </p>
        <TextArea
          className="settings-teleagent-system-prompt"
          value={teleAgentAiSystemPrompt}
          onChange={handleSystemPromptChange}
          label="Дополнительный системный prompt"
          noReplaceNewlines
        />
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
    'teleAgentAiDefaultDepth',
    'teleAgentAiMaxToolIterations',
    'teleAgentAiCompactionMode',
    'teleAgentAiWorkspaceContext',
  ]),
)(SettingsTeleAgentAi));
