import type { FC } from '../../lib/teact/teact';
import type React from '../../lib/teact/teact';
import {
  memo, useEffect, useMemo, useRef, useState,
} from '../../lib/teact/teact';
import { getActions, withGlobal } from '../../global';

import type {
  TeleAgentAiActivity,
  TeleAgentAiError,
  TeleAgentAiPersistedChat,
  TeleAgentAiPersistedMessage,
} from '../../types';

import { selectTabState } from '../../global/selectors';
import { formatPastTimeShort } from '../../util/dates/oldDateFormat';
import renderText from '../common/helpers/renderText';

import useFlag from '../../hooks/useFlag';
import useLang from '../../hooks/useLang';
import useLastCallback from '../../hooks/useLastCallback';
import useOldLang from '../../hooks/useOldLang';

import Icon from '../common/icons/Icon';
import Button from '../ui/Button';
import ConfirmDialog from '../ui/ConfirmDialog';
import InputText from '../ui/InputText';
import ListItem from '../ui/ListItem';

import styles from './TeleAgentAi.module.scss';

const VISIBLE_CHAT_COUNT = 5;

type OwnProps = {
  activeChatId?: string;
  chats: TeleAgentAiPersistedChat[];
  messages: TeleAgentAiPersistedMessage[];
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
      return 'AI is disabled in TeleAgent settings';
    case 'missingBaseUrl':
      return 'Set the API Base URL in TeleAgent AI settings';
    case 'missingApiKey':
      return 'Set the API Key in TeleAgent AI settings';
    case 'invalidApiKey':
      return 'API Key contains unsupported characters. Use ASCII only.';
    case 'missingModel':
      return 'Set the model in TeleAgent AI settings';
    case 'network':
      return 'Could not reach the AI service';
    case 'unauthorized':
      return 'The AI service rejected the credentials';
    case 'server':
      return 'The AI service returned an error';
    case 'badResponse':
      return 'The AI service returned an invalid response';
    default:
      return undefined;
  }
}

function buildActivityViewModel(activity: TeleAgentAiActivity) {
  const hasSteps = Boolean(activity.steps.length);

  return {
    hasSteps,
    statusText: activity.status === 'error' ? 'Error' : 'Running',
    stepsText: activity.steps.length ? `${activity.steps.length} steps` : 'Working',
    progressBarClassName: [
      styles.activityProgressBar,
      activity.status === 'error' && styles.activityProgressBarError,
    ].filter(Boolean).join(' '),
    dotClassName: [
      styles.activityDot,
      activity.status === 'error' && styles.activityDotError,
    ].filter(Boolean).join(' '),
    toggleText: activity.isExpanded ? 'Hide steps' : 'Show steps',
  };
}

function buildPreview(chat: TeleAgentAiPersistedChat) {
  const lastMessage = chat.messages[chat.messages.length - 1];

  if (!lastMessage?.text.trim()) {
    return '';
  }

  return lastMessage.text.replace(/\s+/g, ' ').trim();
}

const TeleAgentAi: FC<OwnProps> = ({
  activeChatId,
  chats,
  messages,
  isLoading,
  activity,
  lastCompletedActivity,
  isLastCompletedActivityVisible,
  error,
  errorMessage,
}) => {
  const {
    closeTeleAgentAiChat,
    deleteTeleAgentAiChat,
    openTeleAgentAiChat,
    sendTeleAgentAiMessage,
    setTeleAgentAiActivityExpanded,
    setTeleAgentAiLastActivityVisible,
  } = getActions();
  const lang = useLang();
  const oldLang = useOldLang();
  const [draft, setDraft] = useState('');
  const [isChatsExpanded, expandChats, collapseChats] = useFlag(false);
  const [chatIdToDelete, setChatIdToDelete] = useState<string | undefined>();
  const messagesRef = useRef<HTMLDivElement>();

  const activeChat = useMemo(() => chats.find((chat) => chat.id === activeChatId), [activeChatId, chats]);
  const visibleChats = isChatsExpanded ? chats : chats.slice(0, VISIBLE_CHAT_COUNT);
  const hiddenChatsCount = chats.length - VISIBLE_CHAT_COUNT;

  const handleDraftChange = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setDraft(e.target.value);
  });

  useEffect(() => {
    messagesRef.current?.scrollTo({
      top: messagesRef.current.scrollHeight,
      behavior: 'smooth',
    });
  }, [activity, activeChatId, error, isLoading, lastCompletedActivity, isLastCompletedActivityVisible, messages]);

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

  const handleOpenChat = useLastCallback((_e: React.MouseEvent<HTMLElement>, chatId: string) => {
    openTeleAgentAiChat({ chatId });
  });

  const handleStartNewChat = useLastCallback(() => {
    closeTeleAgentAiChat();
  });

  const handleRequestDelete = useLastCallback((chatId: string) => {
    setChatIdToDelete(chatId);
  });

  const handleCloseDeleteConfirm = useLastCallback(() => {
    setChatIdToDelete(undefined);
  });

  const handleConfirmDelete = useLastCallback(() => {
    if (!chatIdToDelete) {
      return;
    }

    deleteTeleAgentAiChat({ chatId: chatIdToDelete });
    setChatIdToDelete(undefined);
  });

  const errorText = errorMessage || getErrorText(lang, error);
  const lastAssistantMessageIndex = [...messages].map((message) => message.role).lastIndexOf('assistant');
  const archivedActivityToggleText = isLastCompletedActivityVisible ? 'Hide work log' : 'Show work log';

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

  function renderChatsList() {
    if (!chats.length) {
      return undefined;
    }

    return (
      <div className={styles.chatListBlock}>
        <div className={styles.chatListHeader}>
          <div className={styles.chatListTitle}>Недавние чаты</div>
          {hiddenChatsCount > 0 && !isChatsExpanded && (
            <button type="button" className={styles.chatListToggle} onClick={expandChats}>
              Show all
            </button>
          )}
          {chats.length > VISIBLE_CHAT_COUNT && isChatsExpanded && (
            <button type="button" className={styles.chatListToggle} onClick={collapseChats}>
              Collapse
            </button>
          )}
        </div>
        <div className={styles.chatList}>
          {visibleChats.map((chat) => {
            const preview = buildPreview(chat);

            return (
              <ListItem
                key={chat.id}
                multiline
                ripple
                className={styles.chatListItem}
                buttonClassName={styles.chatListItemButton}
                secondaryIcon="delete"
                onSecondaryIconClick={() => handleRequestDelete(chat.id)}
                onClick={handleOpenChat}
                clickArg={chat.id}
              >
                <div className={styles.chatListItemContent}>
                  <div className={styles.chatListItemTop}>
                    <span className={styles.chatListItemTitle}>{chat.title}</span>
                    <span className={styles.chatListItemTime}>
                      {formatPastTimeShort(oldLang, chat.updatedAt)}
                    </span>
                  </div>
                  {preview && (
                    <div className={styles.chatListItemPreview}>
                      {preview}
                    </div>
                  )}
                </div>
              </ListItem>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <div ref={messagesRef} className={`${styles.messages} panel-content custom-scroll`}>
        {activeChat && (
          <div className={styles.chatHeader}>
            <Button
              round
              isText
              size="smaller"
              className={styles.chatHeaderBackButton}
              ariaLabel="Back"
              onClick={handleStartNewChat}
            >
              <Icon name="arrow-left" />
            </Button>
            <div className={styles.chatHeaderText}>
              <div className={styles.chatHeaderTitle}>{activeChat.title}</div>
              <div className={styles.chatHeaderMeta}>
                {formatPastTimeShort(oldLang, activeChat.updatedAt)}
              </div>
            </div>
          </div>
        )}
        {messages.length ? messages.map((message, index) => (
          <div
            key={message.id}
            className={`${styles.message} ${message.role === 'assistant' ? styles.messageAssistant : ''}`}
          >
            <div className={styles.messageLabel}>
              {message.role === 'assistant' ? 'TeleAgent' : 'You'}
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
            {renderChatsList()}
            <h4 className={styles.emptyTitle}>TeleAgent AI</h4>
            <p className={styles.emptyText}>
              {chats.length
                ? 'Выберите сохраненный чат или начните новый ниже'
                : 'Сообщений пока нет'}
            </p>
            {!chats.length && (
              <p className={styles.emptyHint}>
                Задайте вопрос ниже, чтобы начать новый чат
              </p>
            )}
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
      <ConfirmDialog
        isOpen={Boolean(chatIdToDelete)}
        onClose={handleCloseDeleteConfirm}
        confirmHandler={handleConfirmDelete}
        confirmIsDestructive
        confirmLabel={lang('Delete')}
        text="Delete this AI chat?"
      />
    </div>
  );
};

export default memo(withGlobal(
  (global): OwnProps => {
    const { teleAgentAi } = selectTabState(global);
    const { activeChatId, byId, chatIds } = global.teleAgentAiHistory;

    return {
      activeChatId,
      chats: chatIds.map((chatId) => byId[chatId]).filter(Boolean),
      messages: activeChatId ? (byId[activeChatId]?.messages || []) : [],
      isLoading: teleAgentAi.isLoading,
      activity: teleAgentAi.activity,
      lastCompletedActivity: teleAgentAi.lastCompletedActivity,
      isLastCompletedActivityVisible: teleAgentAi.isLastCompletedActivityVisible,
      error: teleAgentAi.error,
      errorMessage: teleAgentAi.errorMessage,
    };
  },
)(TeleAgentAi));
