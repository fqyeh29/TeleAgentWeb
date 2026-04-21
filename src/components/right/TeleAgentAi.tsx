import type { FC } from '../../lib/teact/teact';
import type React from '../../lib/teact/teact';
import {
  memo, useEffect, useRef, useState,
} from '../../lib/teact/teact';
import { getActions, withGlobal } from '../../global';

import type { TeleAgentAiError, TeleAgentAiMessage } from '../../types';

import { selectTabState } from '../../global/selectors';

import useLang from '../../hooks/useLang';
import useLastCallback from '../../hooks/useLastCallback';

import Icon from '../common/icons/Icon';
import Button from '../ui/Button';
import InputText from '../ui/InputText';

import styles from './TeleAgentAi.module.scss';

type OwnProps = {
  messages: TeleAgentAiMessage[];
  isLoading?: boolean;
  error?: TeleAgentAiError;
};

function getErrorText(lang: ReturnType<typeof useLang>, error?: TeleAgentAiError) {
  switch (error) {
    case 'disabled':
      return lang('TeleAgentAIErrorDisabled');
    case 'missingBaseUrl':
      return lang('TeleAgentAIErrorMissingBaseUrl');
    case 'missingApiKey':
      return lang('TeleAgentAIErrorMissingApiKey');
    case 'missingModel':
      return lang('TeleAgentAIErrorMissingModel');
    case 'network':
      return lang('TeleAgentAIErrorNetwork');
    case 'unauthorized':
      return lang('TeleAgentAIErrorUnauthorized');
    case 'server':
      return lang('TeleAgentAIErrorServer');
    case 'badResponse':
      return lang('TeleAgentAIErrorBadResponse');
    default:
      return undefined;
  }
}

const TeleAgentAi: FC<OwnProps> = ({
  messages,
  isLoading,
  error,
}) => {
  const { sendTeleAgentAiMessage } = getActions();
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
  }, [messages, isLoading, error]);

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

  const errorText = getErrorText(lang, error);

  return (
    <div className={styles.root}>
      <div ref={messagesRef} className={`${styles.messages} panel-content custom-scroll`}>
        {messages.length ? messages.map((message) => (
          <div
            key={message.id}
            className={`${styles.message} ${message.role === 'assistant' ? styles.messageAssistant : ''}`}
          >
            <div className={styles.messageLabel}>
              {message.role === 'assistant' ? 'TeleAgent' : 'You'}
            </div>
            <div className={styles.messageBubble}>{message.text}</div>
          </div>
        )) : (
          <div className={styles.emptyState}>
            <h4 className={styles.emptyTitle}>TeleAgent AI</h4>
            <p className={styles.emptyText}>{lang('NoMessages')}</p>
            <p className={styles.emptyHint}>{lang('TeleAgentAIEmptyHint')}</p>
          </div>
        )}
        {isLoading && (
          <div className={`${styles.message} ${styles.messageAssistant}`}>
            <div className={styles.messageLabel}>TeleAgent</div>
            <div className={`${styles.messageBubble} ${styles.messagePending}`}>
              {lang('TeleAgentAILoading')}
            </div>
          </div>
        )}
        {errorText && (
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
      error: teleAgentAi.error,
    };
  },
)(TeleAgentAi));
