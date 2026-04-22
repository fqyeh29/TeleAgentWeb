import type { FC } from '../../lib/teact/teact';
import type React from '../../lib/teact/teact';
import {
  memo, useEffect, useRef, useState,
} from '../../lib/teact/teact';
import { getActions, withGlobal } from '../../global';

import type { TeleAgentAiActivity, TeleAgentAiError, TeleAgentAiMessage } from '../../types';

import { selectTabState } from '../../global/selectors';
import renderText from '../common/helpers/renderText';

import useLang from '../../hooks/useLang';
import useLastCallback from '../../hooks/useLastCallback';

import Icon from '../common/icons/Icon';
import Button from '../ui/Button';
import InputText from '../ui/InputText';

import styles from './TeleAgentAi.module.scss';

type OwnProps = {
  messages: TeleAgentAiMessage[];
  isLoading?: boolean;
  activity?: TeleAgentAiActivity;
  lastCompletedActivity?: TeleAgentAiActivity;
  isLastCompletedActivityVisible?: boolean;
  error?: TeleAgentAiError;
  errorMessage?: string;
};

function getErrorText(_lang: ReturnType<typeof useLang>, error?: TeleAgentAiError) {
  switch (error) {
    case 'disabled':
      return 'AI отключён в настройках TeleAgent';
    case 'missingBaseUrl':
      return 'Укажите API Base URL в настройках TeleAgent AI';
    case 'missingApiKey':
      return 'Укажите API Key в настройках TeleAgent AI';
    case 'missingModel':
      return 'Укажите модель в настройках TeleAgent AI';
    case 'network':
      return 'Не удалось связаться с AI-сервисом';
    case 'unauthorized':
      return 'AI-сервис отклонил учётные данные';
    case 'server':
      return 'AI-сервис вернул ошибку';
    case 'badResponse':
      return 'AI-сервис вернул некорректный ответ';
    default:
      return undefined;
  }
}

function getStepWord(count: number) {
  const mod10 = count % 10;
  const mod100 = count % 100;

  if (mod10 === 1 && mod100 !== 11) {
    return 'шаг';
  }

  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return 'шага';
  }

  return 'шагов';
}

function buildActivityViewModel(activity: TeleAgentAiActivity) {
  const hasSteps = Boolean(activity.steps.length);

  return {
    hasSteps,
    statusText: activity.status === 'error' ? 'Ошибка' : 'Выполняется',
    stepsText: activity.steps.length
      ? `${activity.steps.length} ${getStepWord(activity.steps.length)}`
      : 'Идёт обработка',
    progressBarClassName: [
      styles.activityProgressBar,
      activity.status === 'error' && styles.activityProgressBarError,
    ].filter(Boolean).join(' '),
    dotClassName: [
      styles.activityDot,
      activity.status === 'error' && styles.activityDotError,
    ].filter(Boolean).join(' '),
    toggleText: activity.isExpanded ? 'Скрыть шаги' : 'Показать шаги',
  };
}

const TeleAgentAi: FC<OwnProps> = ({
  messages,
  isLoading,
  activity,
  lastCompletedActivity,
  isLastCompletedActivityVisible,
  error,
  errorMessage,
}) => {
  const {
    sendTeleAgentAiMessage,
    setTeleAgentAiActivityExpanded,
    setTeleAgentAiLastActivityVisible,
  } = getActions();
  const lang = useLang();
  const [draft, setDraft] = useState('');
  const messagesRef = useRef<HTMLDivElement>();

  const handleDraftChange = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setDraft(e.target.value);
  });

  useEffect(() => {
    messagesRef.current?.scrollTo({
      top: messagesRef.current.scrollHeight,
      behavior: 'smooth',
    });
  }, [activity, error, isLoading, lastCompletedActivity, isLastCompletedActivityVisible, messages]);

  const handleSend = useLastCallback(() => {
    const trimmedDraft = draft.trim();

    if (!trimmedDraft || isLoading) {
      return;
    }

    sendTeleAgentAiMessage({ text: trimmedDraft });
    setDraft('');
  });

  const handleDraftKeyDown = useLastCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') {
      return;
    }

    e.preventDefault();
    handleSend();
  });

  const handleToggleActivity = useLastCallback(() => {
    const targetActivity = activity || lastCompletedActivity;

    if (!targetActivity) {
      return;
    }

    setTeleAgentAiActivityExpanded({ isExpanded: !targetActivity.isExpanded });
  });

  const handleToggleLastCompletedActivity = useLastCallback(() => {
    setTeleAgentAiLastActivityVisible({ isVisible: !isLastCompletedActivityVisible });
  });

  const errorText = errorMessage || getErrorText(lang, error);
  const lastAssistantMessageIndex = [...messages].map((message) => message.role).lastIndexOf('assistant');
  const archivedActivityToggleText = isLastCompletedActivityVisible ? 'Скрыть ход работы' : 'Показать ход работы';

  function renderActivityBlock(targetActivity: TeleAgentAiActivity) {
    const view = buildActivityViewModel(targetActivity);

    return (
      <div className={styles.activityBlock}>
        <div className={styles.activityTopRow}>
          <div className={styles.activityMain}>
            <div className={styles.activityHeadlineRow}>
              <span className={view.dotClassName} />
              <div className={styles.activityHeadline}>{targetActivity.currentHeadline}</div>
            </div>
            <div className={styles.activityMetaRow}>
              <span>{view.statusText}</span>
              <span>{view.stepsText}</span>
            </div>
          </div>
          {view.hasSteps && (
            <button
              type="button"
              className={styles.activityToggle}
              onClick={handleToggleActivity}
            >
              {view.toggleText}
            </button>
          )}
        </div>
        <div className={styles.activityProgressTrack}>
          <div className={view.progressBarClassName} />
        </div>
        {targetActivity.errorText && (
          <div className={styles.activityErrorText}>
            {targetActivity.errorText}
          </div>
        )}
        {targetActivity.isExpanded && view.hasSteps && (
          <div className={styles.activitySteps}>
            {targetActivity.steps.map((step) => (
              <div key={step.id} className={styles.activityStep}>
                {step.label}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  function renderArchivedActivityBlock(targetActivity: TeleAgentAiActivity) {
    if (!targetActivity.steps.length) {
      return undefined;
    }

    return (
      <div className={`${styles.activityBlock} ${styles.activityBlockArchived}`}>
        <div className={styles.activitySteps}>
          {targetActivity.steps.map((step) => (
            <div key={step.id} className={styles.activityStep}>
              {step.label}
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <div ref={messagesRef} className={`${styles.messages} panel-content custom-scroll`}>
        {messages.length ? messages.map((message, index) => (
          <div
            key={message.id}
            className={`${styles.message} ${message.role === 'assistant' ? styles.messageAssistant : ''}`}
          >
            <div className={styles.messageLabel}>
              {message.role === 'assistant' ? 'TeleAgent' : 'Вы'}
            </div>
            {index === lastAssistantMessageIndex && lastCompletedActivity && (
              <div className={styles.archivedActivityWrap}>
                <button
                  type="button"
                  className={styles.archivedActivityButton}
                  onClick={handleToggleLastCompletedActivity}
                >
                  {archivedActivityToggleText}
                </button>
                {isLastCompletedActivityVisible && renderArchivedActivityBlock(lastCompletedActivity)}
              </div>
            )}
            <div className={styles.messageBubble}>
              {renderText(message.text, ['simple_markdown', 'emoji', 'br', 'links'])}
            </div>
          </div>
        )) : (
          <div className={styles.emptyState}>
            <h4 className={styles.emptyTitle}>TeleAgent AI</h4>
            <p className={styles.emptyText}>Сообщений пока нет</p>
            <p className={styles.emptyHint}>Задайте вопрос, чтобы начать диалог</p>
          </div>
        )}
        {activity && renderActivityBlock(activity)}
        {errorText && !activity && (
          <div className={`${styles.message} ${styles.messageAssistant}`}>
            <div className={styles.messageLabel}>TeleAgent</div>
            <div className={`${styles.messageBubble} ${styles.messageError}`}>
              {errorText}
            </div>
          </div>
        )}
      </div>
      <div className={styles.composer}>
        <InputText
          className={styles.input}
          value={draft}
          onChange={handleDraftChange}
          onKeyDown={handleDraftKeyDown}
          placeholder={lang('TeleAgentAIPlaceholder')}
          teactExperimentControlled
          disabled={Boolean(isLoading)}
        />
        <Button
          round
          color="secondary"
          className="main-button send"
          disabled={!draft.trim() || Boolean(isLoading)}
          isLoading={Boolean(isLoading)}
          noFastClick
          allowDisabledClick
          onClick={handleSend}
          size="smaller"
          ariaLabel={lang('SendMessage')}
        >
          <Icon name="send" />
        </Button>
      </div>
    </div>
  );
};

export default memo(withGlobal(
  (global): OwnProps => {
    const { teleAgentAi } = selectTabState(global);

    return {
      messages: teleAgentAi.messages,
      isLoading: teleAgentAi.isLoading,
      activity: teleAgentAi.activity,
      lastCompletedActivity: teleAgentAi.lastCompletedActivity,
      isLastCompletedActivityVisible: teleAgentAi.isLastCompletedActivityVisible,
      error: teleAgentAi.error,
      errorMessage: teleAgentAi.errorMessage,
    };
  },
)(TeleAgentAi));
