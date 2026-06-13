import { getGlobal, setGlobal } from '../../global';

import type { GlobalState } from '../../global/types';
import type { ThreadId, ThreadReadState } from '../../types';
import type { TeleAgentToolDefinition } from './toolTypes';
import { type ApiChat, type ApiMessage, type ApiUser, MAIN_THREAD_ID } from '../../api/types';

import { ALL_FOLDER_ID, ARCHIVED_FOLDER_ID } from '../../config';
import { getChatTitle, isChatChannel, isChatGroup } from '../../global/helpers/chats';
import { getMessageSummaryText } from '../../global/helpers/messageSummary';
import { getPeerTitle } from '../../global/helpers/peers';
import {
  addChatMessagesById,
  addMessages,
  replaceChatFullInfo,
  updateChats,
  updateChatsLastMessageId,
  updateUsers,
} from '../../global/reducers';
import { updateMainThreadReadStates } from '../../global/reducers/threads';
import {
  selectChat,
  selectChatFullInfo,
  selectChatLastMessage,
  selectChatMessage,
  selectChatMessages,
  selectSender,
  selectUser,
} from '../../global/selectors';
import {
  selectCurrentMessageList,
  selectFirstUnreadId,
  selectRealLastReadId,
} from '../../global/selectors/messages';
import { selectThreadReadState } from '../../global/selectors/threads';
import {
  getOrderedIds as getFolderOrderedIds,
  getUnreadChatsByFolderId,
  getUnreadCounters as getFolderUnreadCounters,
} from '../../util/folderManager';
import { buildCollectionByKey, unique } from '../../util/iteratees';
import { getTranslationFn } from '../../util/localization';
import { prepareSearchWordsForNeedle } from '../../util/searchWords';
import trimText from '../../util/trimText';
import { callApi } from '../../api/gramjs';
import { FindInTelegramSubAgentTool } from './subAgents/finderTool';

const DEFAULT_DIALOG_LIMIT = 10;
const DEFAULT_MESSAGE_LIMIT = 10;
const MAX_DIALOG_LIMIT = 20;
const MAX_MESSAGE_LIMIT = 20;
const MAX_PREVIEW_LENGTH = 280;
const MAX_FOCUSED_MESSAGE_LENGTH = 4000;
const MAX_PARTICIPANTS_IN_SUMMARY = 5;
const MAX_READ_DIALOG_FETCH_STEPS = 5;
const MAX_DIALOG_SIMILAR_DISTANCE = 2;
const PAGINATION_GUIDANCE = [
  'If hasMore is true and evidence is insufficient, call this tool again with the returned cursor.',
  'Use cursor for tool pagination; do not pass a messageId as offset.',
  'An empty or small page only proves that this page/scope was checked, not that the item does not exist elsewhere.',
].join(' ');
const MESSAGE_PREVIEW_GUIDANCE = [
  'This tool returns message previews, not guaranteed full message text.',
  'If a specific message is important, truncated, or will support the final answer,',
  'call get_message_context with chatId and messageId before concluding.',
].join(' ');

let RE_NOT_SEARCHABLE: RegExp;

try {
  RE_NOT_SEARCHABLE = /[^\p{L}\p{N}]+/gu;
} catch {
  RE_NOT_SEARCHABLE = /[^\wа-яёіїєґ]+/gi;
}

type DialogCursor = {
  offsetDate?: number;
  offsetId?: number;
  offsetPeerId?: string;
};

type MessageCursor = {
  offsetId?: number;
  offsetPeerId?: string;
  offsetRate?: number;
};

type OffsetCursor = {
  offset: number;
};

type UnreadScope = 'people' | 'bots' | 'groups' | 'channels' | 'all';

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function asRecord(value: unknown, label: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }

  return value as Record<string, unknown>;
}

function optionalString(value: unknown, label: string) {
  if (value === undefined || (typeof value === 'object' && !value) || value === '') {
    return undefined;
  }

  if (typeof value !== 'string') {
    throw new Error(`${label} must be a string.`);
  }

  return value;
}

function requiredString(value: unknown, label: string) {
  const parsed = optionalString(value, label);

  if (!parsed) {
    throw new Error(`${label} is required.`);
  }

  return parsed;
}

function optionalNumber(value: unknown, label: string) {
  if (value === undefined || (typeof value === 'object' && !value) || value === '') {
    return undefined;
  }

  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new Error(`${label} must be a number.`);
  }

  return value;
}

function parseCursor<T>(cursor: unknown, label: string): T | undefined {
  const rawCursor = optionalString(cursor, label);
  if (!rawCursor) {
    return undefined;
  }

  try {
    return JSON.parse(rawCursor) as T;
  } catch {
    throw new Error(`${label} is invalid.`);
  }
}

function serializeCursor(cursor: Record<string, unknown> | undefined) {
  if (!cursor) {
    return undefined;
  }

  return JSON.stringify(cursor);
}

function parseDate(value: unknown, label: string, asDayEnd = false) {
  const rawValue = optionalString(value, label);
  if (!rawValue) {
    return undefined;
  }

  const match = rawValue.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    throw new Error(`${label} must use YYYY-MM-DD format, for example 2026-04-22.`);
  }

  const [, yearRaw, monthRaw, dayRaw] = match;
  const year = Number(yearRaw);
  const monthIndex = Number(monthRaw) - 1;
  const day = Number(dayRaw);

  const date = asDayEnd
    ? new Date(year, monthIndex, day, 23, 59, 59, 999)
    : new Date(year, monthIndex, day, 0, 0, 0, 0);

  if (Number.isNaN(date.getTime())) {
    throw new Error(`${label} must use YYYY-MM-DD format, for example 2026-04-22.`);
  }

  return Math.floor(date.getTime() / 1000);
}

function parseQueryList(value: unknown, label: string) {
  if (Array.isArray(value)) {
    const queries = value
      .map((item, index) => requiredString(item, `${label}[${index}]`).trim())
      .filter(Boolean);

    if (!queries.length) {
      throw new Error(`${label} must contain at least one non-empty string.`);
    }

    return unique(queries);
  }

  return [requiredString(value, label).trim()];
}

function padDatePart(value: number) {
  return String(value).padStart(2, '0');
}

function formatUnixTimestamp(timestamp?: number) {
  if (!timestamp) {
    return undefined;
  }

  const date = new Date(timestamp * 1000);

  return [
    date.getFullYear(),
    padDatePart(date.getMonth() + 1),
    padDatePart(date.getDate()),
  ].join('-')
  + ` ${padDatePart(date.getHours())}:${padDatePart(date.getMinutes())}:${padDatePart(date.getSeconds())}`;
}

function normalizeSearchText(value: string) {
  return value
    .toLowerCase()
    .replace(RE_NOT_SEARCHABLE, ' ')
    .trim();
}

function compactSearchText(value: string) {
  return normalizeSearchText(value).replace(/\s+/g, '');
}

function isSubsequence(needle: string, haystack: string) {
  let needleIndex = 0;

  for (let i = 0; i < haystack.length && needleIndex < needle.length; i++) {
    if (haystack[i] === needle[needleIndex]) {
      needleIndex++;
    }
  }

  return needleIndex === needle.length;
}

function getLevenshteinDistance(a: string, b: string, maxDistance = MAX_DIALOG_SIMILAR_DISTANCE) {
  if (a === b) {
    return 0;
  }

  if (Math.abs(a.length - b.length) > maxDistance) {
    return maxDistance + 1;
  }

  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  const current = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    let minInRow = current[0];

    for (let j = 1; j <= b.length; j++) {
      const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + substitutionCost,
      );
      minInRow = Math.min(minInRow, current[j]);
    }

    if (minInRow > maxDistance) {
      return maxDistance + 1;
    }

    for (let j = 0; j <= b.length; j++) {
      previous[j] = current[j];
    }
  }

  return previous[b.length];
}

function getNormalizedDialogType(global: GlobalState, chat: ApiChat) {
  if (isChatChannel(chat)) {
    return 'channel';
  }

  if (chat.type === 'chatTypeSuperGroup') {
    return 'supergroup';
  }

  if (chat.type === 'chatTypeBasicGroup' || isChatGroup(chat)) {
    return 'group';
  }

  const user = selectUser(global, chat.id);
  if (user?.type === 'userTypeBot') {
    return 'bot';
  }

  return 'private';
}

function getUnreadCount(global: GlobalState, chatId: string, readState?: ThreadReadState) {
  return readState?.unreadCount ?? selectThreadReadState(global, chatId, MAIN_THREAD_ID)?.unreadCount ?? 0;
}

function getUnreadScope(value: unknown, label = 'scope'): UnreadScope {
  const scope = optionalString(value, label) || 'people';

  if (scope === 'people' || scope === 'bots' || scope === 'groups' || scope === 'channels' || scope === 'all') {
    return scope;
  }

  throw new Error(`${label} must be one of: people, bots, groups, channels, all.`);
}

function getDialogSearchCandidates(global: GlobalState, chatId: string) {
  const chat = selectChat(global, chatId);
  if (!chat) {
    return [];
  }

  const candidates = [
    getChatTitle(getTranslationFn(), chat, chatId === global.currentUserId),
    chat.title,
    ...(chat.usernames?.map(({ username }) => username) || []),
  ];

  return unique(candidates.filter(Boolean));
}

function getDialogQueryMatch(global: GlobalState, chatId: string, query: string) {
  const candidates = getDialogSearchCandidates(global, chatId);
  if (!candidates.length) {
    return undefined;
  }

  const exactMatcher = prepareSearchWordsForNeedle(query);
  if (candidates.some((candidate) => exactMatcher(candidate))) {
    return {
      score: 100,
      matchType: 'exact' as const,
    };
  }

  const compactQuery = compactSearchText(query);
  if (!compactQuery) {
    return undefined;
  }

  let bestSimilarScore = 0;

  candidates.forEach((candidate) => {
    const compactCandidate = compactSearchText(candidate);
    if (!compactCandidate) {
      return;
    }

    if (compactCandidate.includes(compactQuery) || compactQuery.includes(compactCandidate)) {
      bestSimilarScore = Math.max(bestSimilarScore, 80);
      return;
    }

    if (isSubsequence(compactQuery, compactCandidate)) {
      bestSimilarScore = Math.max(bestSimilarScore, 60);
      return;
    }

    if (getLevenshteinDistance(compactQuery, compactCandidate) <= MAX_DIALOG_SIMILAR_DISTANCE) {
      bestSimilarScore = Math.max(bestSimilarScore, 50);
    }
  });

  if (!bestSimilarScore) {
    return undefined;
  }

  return {
    score: bestSimilarScore,
    matchType: 'similar' as const,
  };
}

function formatDialogCompact(global: GlobalState, chatId: string, readState?: ThreadReadState) {
  const chat = selectChat(global, chatId);
  if (!chat) {
    return undefined;
  }

  const lastMessage = selectChatLastMessage(global, chatId);

  return {
    chatId,
    title: getChatTitle(getTranslationFn(), chat, chatId === global.currentUserId),
    type: getNormalizedDialogType(global, chat),
    unreadCount: getUnreadCount(global, chatId, readState),
    lastActivityAt: lastMessage?.date,
    lastActivityAtText: formatUnixTimestamp(lastMessage?.date),
  };
}

function formatMessage(global: GlobalState, message: ApiMessage, maxTextLength = MAX_PREVIEW_LENGTH) {
  const lang = getTranslationFn();
  const sender = selectSender(global, message);
  const text = getMessageSummaryText(lang, message, undefined, false, maxTextLength, true);

  return {
    messageId: message.id,
    author: sender ? getPeerTitle(lang, sender) : message.senderId,
    timestamp: message.date,
    timestampText: formatUnixTimestamp(message.date),
    text: trimText(text, maxTextLength),
    isTextTruncated: text.length > maxTextLength,
  };
}

function formatUnreadMessage(global: GlobalState, message: ApiMessage) {
  const dialog = selectChat(global, message.chatId);
  const { messageId, ...messageData } = formatMessage(global, message);

  return {
    messageId,
    chatId: message.chatId,
    chatTitle: dialog
      ? getChatTitle(getTranslationFn(), dialog, message.chatId === global.currentUserId)
      : message.chatId,
    ...messageData,
  };
}

function formatCurrentDialog(global: GlobalState) {
  const currentMessageList = selectCurrentMessageList(global);
  const chatId = currentMessageList?.chatId;

  if (!currentMessageList || !chatId) {
    return {
      exists: false,
      isOpen: false,
      isSelected: false,
    };
  }

  const chat = selectChat(global, chatId);
  if (!chat) {
    return {
      exists: false,
      isOpen: false,
      isSelected: false,
    };
  }

  const lastMessage = selectChatLastMessage(global, chatId);
  const meta: {
    threadId?: ThreadId;
    lastActivityAt?: number;
    lastActivityAtText?: string;
  } = {};

  if (currentMessageList.threadId !== MAIN_THREAD_ID) {
    meta.threadId = currentMessageList.threadId;
  }

  if (lastMessage?.date) {
    meta.lastActivityAt = lastMessage.date;
    meta.lastActivityAtText = formatUnixTimestamp(lastMessage.date);
  }

  return {
    exists: true,
    chatId,
    title: getChatTitle(getTranslationFn(), chat, chatId === global.currentUserId),
    type: getNormalizedDialogType(global, chat),
    unreadCount: getUnreadCount(global, chatId),
    isOpen: true,
    isSelected: true,
    ...(Object.keys(meta).length ? { meta } : {}),
  };
}

function normalizeFolderItem(global: GlobalState, folderId: number, order: number) {
  const folder = global.chatFolders.byId[folderId];
  const unreadCount = getFolderUnreadCounters()[folderId]?.chatsCount;

  if (folderId === ALL_FOLDER_ID) {
    return {
      folderId,
      title: getTranslationFn()('FilterAllChats'),
      unreadCount,
      order,
      isDefault: true,
    };
  }

  if (!folder) {
    return undefined;
  }

  return {
    folderId,
    title: folder.title.text,
    unreadCount,
    order,
    isDefault: false,
  };
}

function parseOffsetCursor(cursor: unknown, label: string) {
  return parseCursor<OffsetCursor>(cursor, label)?.offset;
}

function serializeOffsetCursor(offset: number | undefined) {
  return offset === undefined ? undefined : serializeCursor({ offset });
}

function paginateItems<T>(items: T[], limit: number, rawOffset?: number) {
  const safeOffset = clamp(rawOffset ?? 0, 0, Number.MAX_SAFE_INTEGER);
  const pageItems = items.slice(safeOffset, safeOffset + limit);
  const nextOffset = safeOffset + pageItems.length;

  return {
    pageItems,
    nextOffset,
    nextCursor: nextOffset < items.length ? serializeOffsetCursor(nextOffset) : undefined,
    hasMore: nextOffset < items.length,
  };
}

function matchesUnreadScope(type: ReturnType<typeof getNormalizedDialogType>, scope: UnreadScope) {
  switch (scope) {
    case 'people':
      return type === 'private';
    case 'bots':
      return type === 'bot';
    case 'groups':
      return type === 'group' || type === 'supergroup';
    case 'channels':
      return type === 'channel';
    case 'all':
      return true;
  }
}

function getScopedUnreadDialogIds(global: GlobalState, scope: UnreadScope) {
  const unreadChatIds = getUnreadChatsByFolderId()[ALL_FOLDER_ID] || [];

  return unreadChatIds.filter((chatId) => {
    const chat = selectChat(global, chatId);
    if (!chat) {
      return false;
    }

    return matchesUnreadScope(getNormalizedDialogType(global, chat), scope);
  });
}

function getUnreadMessagesFromCache(
  global: GlobalState,
  chatId: string,
) {
  const readState = selectThreadReadState(global, chatId, MAIN_THREAD_ID);
  if (!readState?.unreadCount && !readState?.hasUnreadMark) {
    return [];
  }

  const messagesById = selectChatMessages(global, chatId);
  if (!messagesById) {
    return [];
  }

  const firstUnreadId = selectFirstUnreadId(global, chatId, MAIN_THREAD_ID);
  const lastReadId = selectRealLastReadId(global, chatId, MAIN_THREAD_ID) || 0;

  return Object.values(messagesById)
    .filter((message) => (
      message.chatId === chatId
      && !message.isOutgoing
      && message.id > lastReadId
      && (!firstUnreadId || message.id >= firstUnreadId)
    ))
    .sort((left, right) => right.id - left.id);
}

async function ensureUnreadMessagesLoaded(chatId: string, minimumCount = 1) {
  let global = getGlobal();
  let unreadMessages = getUnreadMessagesFromCache(global, chatId);

  if (unreadMessages.length >= minimumCount || !selectThreadReadState(global, chatId, MAIN_THREAD_ID)?.unreadCount) {
    return unreadMessages;
  }

  const chat = selectChat(global, chatId);
  if (!chat) {
    return unreadMessages;
  }

  const result = await callApi('fetchMessages', {
    chat,
    threadId: MAIN_THREAD_ID,
    limit: Math.max(DEFAULT_MESSAGE_LIMIT, MAX_MESSAGE_LIMIT),
  });

  if (result) {
    syncMessageBatch(chatId, result.messages);
    global = getGlobal();
    unreadMessages = getUnreadMessagesFromCache(global, chatId);
  }

  return unreadMessages;
}

function isMessageInDateRange(message: ApiMessage, minDate?: number, maxDate?: number) {
  if (minDate !== undefined && message.date < minDate) {
    return false;
  }

  if (maxDate !== undefined && message.date > maxDate) {
    return false;
  }

  return true;
}

function syncDialogBatch(result: {
  chats: ApiChat[];
  lastMessageByChatId: Record<string, number>;
  messages: ApiMessage[];
  threadReadStatesById?: Record<string, ThreadReadState>;
  users: ApiUser[];
}) {
  let global = getGlobal();

  global = updateChats(global, buildCollectionByKey(result.chats, 'id'));
  global = updateUsers(global, buildCollectionByKey(result.users, 'id'));
  global = addMessages(global, result.messages);
  global = updateChatsLastMessageId(global, result.lastMessageByChatId);

  if (result.threadReadStatesById) {
    global = updateMainThreadReadStates(global, result.threadReadStatesById);
  }

  setGlobal(global);
}

function syncMessageBatch(chatId: string, messages: ApiMessage[]) {
  if (!messages.length) {
    return;
  }

  let global = getGlobal();
  global = addChatMessagesById(global, chatId, buildCollectionByKey(messages, 'id'));
  setGlobal(global);
}

async function ensureChatFullInfo(chatId: string) {
  const currentGlobal = getGlobal();
  const existingChat = selectChat(currentGlobal, chatId);

  if (!existingChat) {
    throw new Error(`Dialog ${chatId} is not available in the current client state.`);
  }

  if (selectChatFullInfo(currentGlobal, chatId)) {
    return;
  }

  const result = await callApi('fetchFullChat', existingChat);
  if (!result) {
    return;
  }

  let global = getGlobal();
  global = updateChats(global, buildCollectionByKey(result.chats, 'id'));
  global = replaceChatFullInfo(global, chatId, result.fullInfo);
  setGlobal(global);
}

function buildParticipantsSummary(global: GlobalState, chatId: string) {
  const fullInfo = selectChatFullInfo(global, chatId);
  if (!fullInfo?.members?.length) {
    return undefined;
  }

  const lang = getTranslationFn();
  const sample = fullInfo.members
    .slice(0, MAX_PARTICIPANTS_IN_SUMMARY)
    .map((member) => {
      const peer = selectUser(global, member.userId) || selectChat(global, member.userId);
      return peer ? getPeerTitle(lang, peer) : member.userId;
    })
    .filter(Boolean);

  return {
    count: fullInfo.members.length,
    sample,
  };
}

async function executeListDialogs(args: unknown) {
  const params = asRecord(args, 'list_dialogs arguments');
  const limit = clamp(optionalNumber(params.limit, 'limit') ?? DEFAULT_DIALOG_LIMIT, 1, MAX_DIALOG_LIMIT);
  const offset = optionalNumber(params.offset, 'offset');
  const cursor = parseCursor<DialogCursor>(params.cursor, 'cursor');

  if (offset !== undefined && !cursor) {
    let global = getGlobal();
    if (!global.chats.listIds.active?.length) {
      const initialBatch = await callApi('fetchChats', { limit: MAX_DIALOG_LIMIT, withPinned: true });
      if (initialBatch) {
        syncDialogBatch(initialBatch);
        global = getGlobal();
      }
    }

    const ids = global.chats.listIds.active || [];
    const safeOffset = clamp(offset, 0, Number.MAX_SAFE_INTEGER);
    const pageIds = ids.slice(safeOffset, safeOffset + limit);

    return {
      items: pageIds.map((chatId) => formatDialogCompact(global, chatId)).filter(Boolean),
      nextOffset: safeOffset + pageIds.length,
      nextCursor: undefined,
      hasMore: safeOffset + pageIds.length < ids.length || !global.chats.isFullyLoaded.active,
    };
  }

  const result = await callApi('fetchChats', {
    limit,
    offsetDate: cursor?.offsetDate,
    offsetId: cursor?.offsetId,
    offsetPeer: cursor?.offsetPeerId ? selectChat(getGlobal(), cursor.offsetPeerId) : undefined,
    withPinned: !cursor,
  });

  if (!result) {
    throw new Error('Unable to load dialogs from Telegram.');
  }

  syncDialogBatch(result);

  const global = getGlobal();

  return {
    items: result.chatIds
      .map((chatId) => formatDialogCompact(global, chatId, result.threadReadStatesById?.[chatId]))
      .filter(Boolean),
    nextOffset: undefined,
    nextCursor: serializeCursor(result.nextOffsetId ? {
      offsetDate: result.nextOffsetDate,
      offsetId: result.nextOffsetId,
      offsetPeerId: result.nextOffsetPeerId,
    } : undefined),
    hasMore: Boolean(result.nextOffsetId && result.chatIds.length >= limit),
  };
}

function executeSearchDialogs(args: unknown) {
  const params = asRecord(args, 'search_dialogs arguments');
  const queries = parseQueryList(params.query, 'query');
  const limit = clamp(optionalNumber(params.limit, 'limit') ?? DEFAULT_DIALOG_LIMIT, 1, MAX_DIALOG_LIMIT);
  const offset = clamp(optionalNumber(params.offset, 'offset') ?? 0, 0, Number.MAX_SAFE_INTEGER);

  const global = getGlobal();
  const ids = unique([
    ...(global.chats.listIds.active || []),
    ...(global.chats.listIds.archived || []),
    ...Object.keys(global.chats.byId),
  ]);

  const matches = ids.map((chatId) => {
    const queryMatches = queries.map((query) => ({
      query,
      match: getDialogQueryMatch(global, chatId, query),
    })).filter((item): item is {
      query: string;
      match: {
        score: number;
        matchType: 'exact' | 'similar';
      };
    } => Boolean(item.match));

    if (!queryMatches.length) {
      return undefined;
    }

    const bestScore = Math.max(...queryMatches.map(({ match }) => match.score));
    const matchType = queryMatches.some(({ match }) => match.matchType === 'exact')
      ? 'exact'
      : 'similar';
    const dialog = formatDialogCompact(global, chatId);

    return dialog ? {
      ...dialog,
      matchedQueries: queryMatches.map(({ query }) => query),
      matchType,
      _score: bestScore,
    } : undefined;
  }).filter((item): item is NonNullable<ReturnType<typeof formatDialogCompact>> & {
    matchedQueries: string[];
    matchType: 'exact' | 'similar';
    _score: number;
  } => Boolean(item));

  matches.sort((left, right) => {
    if (right._score !== left._score) {
      return right._score - left._score;
    }

    return (right.lastActivityAt || 0) - (left.lastActivityAt || 0);
  });

  const pageItems = matches.slice(offset, offset + limit).map(({ _score, ...item }) => item);

  return Promise.resolve({
    items: pageItems,
    nextOffset: offset + pageItems.length,
    hasMore: offset + pageItems.length < matches.length,
    totalKnownMatches: matches.length,
  });
}

async function executeGetDialogMeta(args: unknown) {
  const params = asRecord(args, 'get_dialog_meta arguments');
  const chatId = requiredString(params.chatId, 'chatId');

  await ensureChatFullInfo(chatId);

  const currentGlobal = getGlobal();
  const chat = selectChat(currentGlobal, chatId);

  if (!chat) {
    throw new Error(`Dialog ${chatId} was not found.`);
  }

  const lastMessage = selectChatLastMessage(currentGlobal, chatId);

  return {
    chatId,
    title: getChatTitle(getTranslationFn(), chat, chatId === currentGlobal.currentUserId),
    type: getNormalizedDialogType(currentGlobal, chat),
    unreadCount: getUnreadCount(currentGlobal, chatId),
    participants: buildParticipantsSummary(currentGlobal, chatId),
    lastActivity: lastMessage?.date,
    lastActivityText: formatUnixTimestamp(lastMessage?.date),
  };
}

async function executeReadDialog(args: unknown) {
  const params = asRecord(args, 'read_dialog arguments');
  const chatId = requiredString(params.chatId, 'chatId');
  const limit = clamp(optionalNumber(params.limit, 'limit') ?? DEFAULT_MESSAGE_LIMIT, 1, MAX_MESSAGE_LIMIT);
  const offset = optionalNumber(params.offset, 'offset');
  const cursor = parseCursor<MessageCursor>(params.cursor, 'cursor');
  const direction = optionalString(params.direction, 'direction') || 'older';
  const minDate = parseDate(params.dateFrom, 'dateFrom');
  const maxDate = parseDate(params.dateTo, 'dateTo', true);

  const currentGlobal = getGlobal();
  const chat = selectChat(currentGlobal, chatId);

  if (!chat) {
    throw new Error(`Dialog ${chatId} was not found.`);
  }

  if (offset !== undefined && !cursor) {
    const messagesById = selectChatMessages(currentGlobal, chatId) || {};
    const ids = Object.keys(messagesById)
      .map(Number)
      .filter((messageId) => isMessageInDateRange(messagesById[messageId], minDate, maxDate))
      .sort((a, b) => b - a);
    const safeOffset = clamp(offset, 0, Number.MAX_SAFE_INTEGER);
    const pageIds = ids.slice(safeOffset, safeOffset + limit);

    return {
      chatId,
      messages: pageIds
        .map((messageId) => formatMessage(currentGlobal, messagesById[messageId]))
        .filter(Boolean),
      nextOffset: safeOffset + pageIds.length,
      nextCursor: undefined,
      hasMore: safeOffset + pageIds.length < ids.length,
    };
  }

  if (minDate !== undefined || maxDate !== undefined) {
    const result = await callApi('searchMessagesInChat', {
      peer: chat,
      query: '',
      type: 'text',
      limit,
      minDate,
      maxDate,
      offsetId: cursor?.offsetId,
    });

    if (!result) {
      throw new Error(`Unable to read dialog ${chatId}.`);
    }

    let global = getGlobal();
    global = addMessages(global, result.messages);
    setGlobal(global);
    global = getGlobal();

    return {
      chatId,
      messages: result.messages.map((message) => formatMessage(global, message)),
      nextOffset: undefined,
      nextCursor: serializeCursor(result.nextOffsetId ? { offsetId: result.nextOffsetId } : undefined),
      hasMore: Boolean(result.nextOffsetId && result.messages.length >= limit),
    };
  }

  let offsetId = cursor?.offsetId;
  const addOffset = direction === 'around' ? -Math.max(1, Math.floor(limit / 2)) : offsetId ? -1 : undefined;
  const requestLimit = Math.max(limit + 1, DEFAULT_MESSAGE_LIMIT);
  const collected = new Map<number, ApiMessage>();
  let lastBatchHadMore = true;
  let hasOlderMessagesOutsideRange = false;

  for (let step = 0; step < MAX_READ_DIALOG_FETCH_STEPS && collected.size < limit && lastBatchHadMore; step++) {
    const result = await callApi('fetchMessages', {
      chat,
      threadId: MAIN_THREAD_ID,
      offsetId,
      addOffset,
      limit: requestLimit,
    });

    if (!result) {
      throw new Error(`Unable to read dialog ${chatId}.`);
    }

    syncMessageBatch(chatId, result.messages);

    const nextGlobal = getGlobal();
    const batchMessages = unique(result.messages.map(({ id }) => id))
      .map((messageId) => selectChatMessage(nextGlobal, chatId, messageId))
      .filter((message): message is ApiMessage => Boolean(message))
      .sort((a, b) => b.id - a.id);

    batchMessages.forEach((message) => {
      if (isMessageInDateRange(message, minDate, maxDate)) {
        collected.set(message.id, message);
      } else if (minDate !== undefined && message.date < minDate) {
        hasOlderMessagesOutsideRange = true;
      }
    });

    const oldestMessage = batchMessages[batchMessages.length - 1];
    offsetId = oldestMessage?.id;
    lastBatchHadMore = batchMessages.length >= requestLimit;

    if (minDate !== undefined && oldestMessage && oldestMessage.date < minDate) {
      lastBatchHadMore = false;
    }
  }

  const pageMessages = Array.from(collected.values())
    .sort((a, b) => b.id - a.id)
    .slice(0, limit);
  const nextOffsetId = pageMessages[pageMessages.length - 1]?.id;

  return {
    chatId,
    messages: pageMessages.map((message) => formatMessage(getGlobal(), message)),
    nextOffset: undefined,
    nextCursor: serializeCursor(nextOffsetId ? { offsetId: nextOffsetId } : undefined),
    hasMore: Boolean(
      nextOffsetId && (pageMessages.length >= limit || lastBatchHadMore || hasOlderMessagesOutsideRange),
    ),
  };
}

async function executeSearchMessages(args: unknown) {
  const params = asRecord(args, 'search_messages arguments');
  const query = requiredString(params.query, 'query').trim();
  const chatId = optionalString(params.chatId, 'chatId');
  const limit = clamp(optionalNumber(params.limit, 'limit') ?? DEFAULT_MESSAGE_LIMIT, 1, MAX_MESSAGE_LIMIT);
  const cursor = parseCursor<MessageCursor>(params.cursor, 'cursor');
  const minDate = parseDate(params.dateFrom, 'dateFrom');
  const maxDate = parseDate(params.dateTo, 'dateTo', true);

  let result;
  if (chatId) {
    const currentGlobal = getGlobal();
    const chat = selectChat(currentGlobal, chatId);
    if (!chat) {
      throw new Error(`Dialog ${chatId} was not found.`);
    }

    result = await callApi('searchMessagesInChat', {
      peer: chat,
      query,
      type: 'text',
      limit,
      minDate,
      maxDate,
      offsetId: cursor?.offsetId,
    });
  } else {
    result = await callApi('searchMessagesGlobal', {
      query,
      limit,
      minDate,
      maxDate,
      offsetId: cursor?.offsetId,
      offsetRate: cursor?.offsetRate,
      offsetPeer: cursor?.offsetPeerId
        ? selectChat(getGlobal(), cursor.offsetPeerId)
        : undefined,
      type: 'text',
    });
  }

  if (!result) {
    throw new Error('Unable to search messages.');
  }

  let global = getGlobal();
  global = addMessages(global, result.messages);
  setGlobal(global);
  global = getGlobal();

  const items = result.messages.slice(0, limit).map((message) => {
    const dialog = selectChat(global, message.chatId);

    return {
      chatId: message.chatId,
      chatTitle: dialog
        ? getChatTitle(getTranslationFn(), dialog, message.chatId === global.currentUserId)
        : message.chatId,
      ...formatMessage(global, message),
    };
  });

  return {
    results: items,
    nextOffset: undefined,
    nextCursor: serializeCursor(result.nextOffsetId ? {
      offsetId: result.nextOffsetId,
      offsetPeerId: result.nextOffsetPeerId,
      offsetRate: result.nextOffsetRate,
    } : undefined),
    hasMore: Boolean(result.nextOffsetId && result.messages.length >= limit),
  };
}

async function executeGetMessageContext(args: unknown) {
  const params = asRecord(args, 'get_message_context arguments');
  const chatId = requiredString(params.chatId, 'chatId');
  const messageId = optionalNumber(params.messageId, 'messageId');
  const before = clamp(optionalNumber(params.before, 'before') ?? 3, 0, 10);
  const after = clamp(optionalNumber(params.after, 'after') ?? 3, 0, 10);

  if (!messageId) {
    throw new Error('messageId is required.');
  }

  const global = getGlobal();
  const chat = selectChat(global, chatId);
  if (!chat) {
    throw new Error(`Dialog ${chatId} was not found.`);
  }

  const result = await callApi('fetchMessages', {
    chat,
    threadId: MAIN_THREAD_ID,
    offsetId: messageId,
    addOffset: -(before + 1),
    limit: before + after + 1,
  });

  if (!result) {
    throw new Error('Unable to load message context.');
  }

  syncMessageBatch(chatId, result.messages);

  const nextGlobal = getGlobal();
  let contextMessages = result.messages
    .map(({ id }) => selectChatMessage(nextGlobal, chatId, id))
    .filter((message): message is ApiMessage => Boolean(message));

  const directTarget = selectChatMessage(nextGlobal, chatId, messageId);
  if (directTarget && !contextMessages.some((message) => message.id === messageId)) {
    contextMessages = contextMessages.concat(directTarget);
  }

  contextMessages = contextMessages.sort((a, b) => a.id - b.id);

  return {
    chatId,
    target: directTarget ? formatMessage(nextGlobal, directTarget, MAX_FOCUSED_MESSAGE_LENGTH) : undefined,
    surroundingMessages: contextMessages.map((message) => formatMessage(
      nextGlobal,
      message,
      message.id === messageId ? MAX_FOCUSED_MESSAGE_LENGTH : MAX_PREVIEW_LENGTH,
    )),
    note: [
      'Target message is returned with a larger text budget.',
      'Surrounding messages are context previews unless they are the target.',
    ].join(' '),
  };
}

function executeGetCurrentDialog() {
  return Promise.resolve(formatCurrentDialog(getGlobal()));
}

function executeListFolders() {
  const global = getGlobal();
  const orderedFolderIds = global.chatFolders.orderedIds || [];
  const folderIds = unique([
    ALL_FOLDER_ID,
    ...orderedFolderIds,
    ...(orderedFolderIds.includes(ARCHIVED_FOLDER_ID) ? [ARCHIVED_FOLDER_ID] : []),
  ]);

  return Promise.resolve({
    items: folderIds
      .map((folderId, order) => normalizeFolderItem(global, folderId, order))
      .filter(Boolean),
    totalKnown: folderIds.length,
  });
}

function executeListDialogsInFolder(args: unknown) {
  const params = asRecord(args, 'list_dialogs_in_folder arguments');
  const folderId = optionalNumber(params.folderId, 'folderId');
  const limit = clamp(optionalNumber(params.limit, 'limit') ?? DEFAULT_DIALOG_LIMIT, 1, MAX_DIALOG_LIMIT);
  const offset = optionalNumber(params.offset, 'offset') ?? parseOffsetCursor(params.cursor, 'cursor') ?? 0;

  if (folderId === undefined) {
    throw new Error('folderId is required.');
  }

  const global = getGlobal();
  const orderedIds = getFolderOrderedIds(folderId) || [];
  const items = orderedIds
    .map((chatId) => formatDialogCompact(global, chatId))
    .filter(Boolean);
  const pagination = paginateItems(items, limit, offset);

  return Promise.resolve({
    items: pagination.pageItems,
    nextOffset: pagination.hasMore ? pagination.nextOffset : undefined,
    nextCursor: pagination.nextCursor,
    hasMore: pagination.hasMore,
  });
}

function executeGetUnreadDialogs(args: unknown) {
  const params = asRecord(args, 'get_unread_dialogs arguments');
  const limit = clamp(optionalNumber(params.limit, 'limit') ?? DEFAULT_DIALOG_LIMIT, 1, MAX_DIALOG_LIMIT);
  const offset = optionalNumber(params.offset, 'offset') ?? parseOffsetCursor(params.cursor, 'cursor') ?? 0;
  const scope = getUnreadScope(params.scope);
  const global = getGlobal();
  const items = getScopedUnreadDialogIds(global, scope)
    .map((chatId) => formatDialogCompact(global, chatId))
    .filter(Boolean);
  const pagination = paginateItems(items, limit, offset);

  return Promise.resolve({
    scope,
    items: pagination.pageItems,
    nextOffset: pagination.hasMore ? pagination.nextOffset : undefined,
    nextCursor: pagination.nextCursor,
    hasMore: pagination.hasMore,
  });
}

async function executeGetUnreadMessages(args: unknown) {
  const params = asRecord(args, 'get_unread_messages arguments');
  const chatId = optionalString(params.chatId, 'chatId');
  const limit = clamp(optionalNumber(params.limit, 'limit') ?? DEFAULT_MESSAGE_LIMIT, 1, MAX_MESSAGE_LIMIT);
  const offset = optionalNumber(params.offset, 'offset') ?? parseOffsetCursor(params.cursor, 'cursor') ?? 0;
  const scope = getUnreadScope(params.scope);

  if (chatId) {
    const currentGlobal = getGlobal();
    const chat = selectChat(currentGlobal, chatId);
    if (!chat) {
      throw new Error(`Dialog ${chatId} was not found.`);
    }

    const unreadMessages = await ensureUnreadMessagesLoaded(chatId, limit);
    const formatted = unreadMessages
      .map((message) => formatUnreadMessage(getGlobal(), message))
      .filter(Boolean);
    const pagination = paginateItems(formatted, limit, offset);

    return {
      chatId,
      messages: pagination.pageItems,
      nextOffset: pagination.hasMore ? pagination.nextOffset : undefined,
      nextCursor: pagination.nextCursor,
      hasMore: pagination.hasMore,
    };
  }

  const unreadDialogIds = getScopedUnreadDialogIds(getGlobal(), scope);
  const collected: ReturnType<typeof formatUnreadMessage>[] = [];

  for (const unreadChatId of unreadDialogIds) {
    const unreadMessages = (await ensureUnreadMessagesLoaded(unreadChatId, 1)).slice(0, MAX_MESSAGE_LIMIT);
    unreadMessages.forEach((message) => {
      collected.push(formatUnreadMessage(getGlobal(), message));
    });
  }

  collected.sort((left, right) => (right.timestamp || 0) - (left.timestamp || 0));

  const pagination = paginateItems(collected, limit, offset);

  return {
    scope,
    messages: pagination.pageItems,
    nextOffset: pagination.hasMore ? pagination.nextOffset : undefined,
    nextCursor: pagination.nextCursor,
    hasMore: pagination.hasMore,
  };
}

export function getBaseTeleAgentToolDefinitions(): TeleAgentToolDefinition[] {
  return [
    {
      name: 'get_current_dialog',
      description: 'Return compact information about the currently open dialog in the UI.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {},
      },
      execute: executeGetCurrentDialog,
    },
    {
      name: 'list_folders',
      description: 'Return the list of available dialog folders in a compact normalized shape.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {},
      },
      execute: executeListFolders,
    },
    {
      name: 'list_dialogs_in_folder',
      description: `Return a compact page of dialogs inside one folder. ${PAGINATION_GUIDANCE}`,
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['folderId'],
        properties: {
          folderId: { type: 'number', description: 'Folder ID. Required.' },
          limit: { type: 'number', description: 'Number of dialogs to return. Default 10, max 20.' },
          offset: { type: 'number', description: 'Optional local offset for pagination.' },
          cursor: { type: 'string', description: 'Opaque cursor returned by a previous list_dialogs_in_folder call.' },
        },
      },
      execute: executeListDialogsInFolder,
    },
    {
      name: 'list_dialogs',
      description: `Return a page of dialogs sorted by recent activity. ${PAGINATION_GUIDANCE}`,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          limit: { type: 'number', description: 'Number of dialogs to return. Default 10, max 20.' },
          offset: { type: 'number', description: 'Optional local offset for already loaded dialogs.' },
          cursor: { type: 'string', description: 'Opaque cursor returned by a previous list_dialogs call.' },
          sort: { type: 'string', description: 'Only "recent" is supported in MVP.' },
        },
      },
      execute: executeListDialogs,
    },
    {
      name: 'search_dialogs',
      description: 'Search known dialogs by title, usernames, and local metadata.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['query'],
        properties: {
          query: {
            description: 'A single query string or an array of query strings to merge. required',
          },
          limit: { type: 'number', description: 'Number of dialogs to return. Default 10, max 20.' },
          offset: { type: 'number', description: 'Result offset for pagination.' },
        },
      },
      execute: executeSearchDialogs,
    },
    {
      name: 'get_dialog_meta',
      description: 'Return compact metadata for one dialog.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['chatId'],
        properties: {
          chatId: { type: 'string', description: 'Dialog chat ID.' },
        },
      },
      execute: executeGetDialogMeta,
    },
    {
      name: 'read_dialog',
      description: `Read a page of dialog message previews. ${MESSAGE_PREVIEW_GUIDANCE} ${PAGINATION_GUIDANCE}`,
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['chatId'],
        properties: {
          chatId: { type: 'string', description: 'Dialog chat ID. Required' },
          limit: { type: 'number', description: 'Number of messages to return. Default 10, max 20.' },
          offset: {
            type: 'number',
            description: 'Optional local list offset for already cached messages. This is not a messageId.',
          },
          cursor: {
            type: 'string',
            description: 'Opaque cursor returned by a previous read_dialog call. Prefer this for pagination.',
          },
          dateFrom: {
            type: 'string',
            description: 'Optional lower bound in YYYY-MM-DD format, for example 2026-04-01.',
          },
          dateTo: {
            type: 'string',
            description: 'Optional upper bound in YYYY-MM-DD format, for example 2026-04-30.',
          },
          direction: {
            type: 'string',
            description: 'Use "older" for older messages or "around" for context-like paging.',
          },
        },
      },
      execute: executeReadDialog,
    },
    {
      name: 'search_messages',
      description: [
        'Search message previews by text, optionally within a specific dialog.',
        MESSAGE_PREVIEW_GUIDANCE,
        PAGINATION_GUIDANCE,
      ].join(' '),
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['query'],
        properties: {
          query: { type: 'string', description: 'Search query text. Required' },
          chatId: { type: 'string', description: 'Optional dialog chat ID to scope the search.' },
          dateFrom: {
            type: 'string',
            description: 'Optional lower bound in YYYY-MM-DD format, for example 2026-04-01.',
          },
          dateTo: {
            type: 'string',
            description: 'Optional upper bound in YYYY-MM-DD format, for example 2026-04-30.',
          },
          limit: { type: 'number', description: 'Number of messages to return. Default 10, max 20.' },
          cursor: {
            type: 'string',
            description: 'Opaque cursor returned by a previous search_messages call. Prefer this for pagination.',
          },
        },
      },
      execute: executeSearchMessages,
    },
    {
      name: 'get_unread_dialogs',
      description: `Return unread dialogs, defaulting to personal dialogs with people only. ${PAGINATION_GUIDANCE}`,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          limit: { type: 'number', description: 'Number of dialogs to return. Default 10, max 20.' },
          offset: {
            type: 'number',
            description: 'Optional local list offset for pagination. This is not a messageId.',
          },
          cursor: { type: 'string', description: 'Opaque cursor returned by a previous get_unread_dialogs call.' },
          scope: {
            type: 'string',
            description: 'Optional unread scope: people, bots, groups, channels, or all. Default is people.',
          },
        },
      },
      execute: executeGetUnreadDialogs,
    },
    {
      name: 'get_unread_messages',
      description: [
        'Return unread messages from one dialog or from unread dialogs, defaulting to people only.',
        PAGINATION_GUIDANCE,
      ].join(' '),
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          chatId: { type: 'string', description: 'Optional dialog chat ID to read unread messages from.' },
          limit: { type: 'number', description: 'Number of messages to return. Default 10, max 20.' },
          offset: { type: 'number', description: 'Optional local offset for pagination.' },
          cursor: { type: 'string', description: 'Opaque cursor returned by a previous get_unread_messages call.' },
          scope: {
            type: 'string',
            description: 'Optional unread scope: people, bots, groups, channels, or all. Default is people.',
          },
        },
      },
      execute: executeGetUnreadMessages,
    },
    {
      name: 'get_message_context',
      description: [
        'Load a target message and a small window around it.',
        'Use this after read_dialog/search_messages when a message is important, truncated,',
        'or needed as evidence for the final answer.',
        'The target message is returned with a larger text budget than preview tools.',
      ].join(' '),
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['chatId', 'messageId'],
        properties: {
          chatId: { type: 'string', description: 'Dialog chat ID. Required' },
          messageId: { type: 'number', description: 'Target message ID. Required' },
          before: { type: 'number', description: 'How many messages before the target to include.' },
          after: { type: 'number', description: 'How many messages after the target to include.' },
        },
      },
      execute: executeGetMessageContext,
    },
  ];
}

export function getTeleAgentToolDefinitions(options?: {
  apiBaseUrl: string;
  apiKey: string;
  model: string;
}): TeleAgentToolDefinition[] {
  const baseTools = getBaseTeleAgentToolDefinitions();

  if (!options) {
    return baseTools;
  }

  return [
    ...baseTools,
    new FindInTelegramSubAgentTool({
      ...options,
      tools: baseTools,
    }).toToolDefinition(),
  ];
}
