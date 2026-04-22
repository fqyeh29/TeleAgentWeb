import { getGlobal, setGlobal } from '../../global';

import type { GlobalState } from '../../global/types';
import type { ThreadReadState } from '../../types';
import { type ApiChat, type ApiMessage, type ApiUser, MAIN_THREAD_ID } from '../../api/types';

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
import { selectThreadReadState } from '../../global/selectors/threads';
import { buildCollectionByKey, unique } from '../../util/iteratees';
import { getTranslationFn } from '../../util/localization';
import { prepareSearchWordsForNeedle } from '../../util/searchWords';
import trimText from '../../util/trimText';
import { callApi } from '../../api/gramjs';

const DEFAULT_DIALOG_LIMIT = 10;
const DEFAULT_MESSAGE_LIMIT = 10;
const MAX_DIALOG_LIMIT = 20;
const MAX_MESSAGE_LIMIT = 20;
const MAX_PREVIEW_LENGTH = 280;
const MAX_PARTICIPANTS_IN_SUMMARY = 5;
const MAX_READ_DIALOG_FETCH_STEPS = 5;
const MAX_DIALOG_SIMILAR_DISTANCE = 2;

let RE_NOT_SEARCHABLE: RegExp;

try {
  RE_NOT_SEARCHABLE = /[^\p{L}\p{N}]+/gu;
} catch {
  RE_NOT_SEARCHABLE = /[^\wа-яёіїєґ]+/gi;
}

type JsonSchema = {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
};

export type TeleAgentToolDefinition = {
  name: string;
  description: string;
  parameters: JsonSchema;
  execute: (args: unknown) => Promise<unknown>;
};

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

function getDialogType(global: GlobalState, chat: ApiChat) {
  if (isChatChannel(chat)) {
    return 'channel';
  }

  if (isChatGroup(chat)) {
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

function formatDialog(global: GlobalState, chatId: string, readState?: ThreadReadState) {
  const chat = selectChat(global, chatId);
  if (!chat) {
    return undefined;
  }

  const lastMessage = selectChatLastMessage(global, chatId);

  return {
    chatId,
    title: getChatTitle(getTranslationFn(), chat, chatId === global.currentUserId),
    type: getDialogType(global, chat),
    unreadCount: getUnreadCount(global, chatId, readState),
    lastMessageDate: lastMessage?.date,
    lastMessageDateText: formatUnixTimestamp(lastMessage?.date),
  };
}

function formatMessage(global: GlobalState, message: ApiMessage) {
  const lang = getTranslationFn();
  const sender = selectSender(global, message);

  return {
    messageId: message.id,
    author: sender ? getPeerTitle(lang, sender) : message.senderId,
    timestamp: message.date,
    timestampText: formatUnixTimestamp(message.date),
    text: trimText(
      getMessageSummaryText(lang, message, undefined, false, MAX_PREVIEW_LENGTH, true),
      MAX_PREVIEW_LENGTH,
    ),
  };
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
      items: pageIds.map((chatId) => formatDialog(global, chatId)).filter(Boolean),
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
      .map((chatId) => formatDialog(global, chatId, result.threadReadStatesById?.[chatId]))
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
    const dialog = formatDialog(global, chatId);

    return dialog ? {
      ...dialog,
      matchedQueries: queryMatches.map(({ query }) => query),
      matchType,
      _score: bestScore,
    } : undefined;
  }).filter((item): item is NonNullable<ReturnType<typeof formatDialog>> & {
    matchedQueries: string[];
    matchType: 'exact' | 'similar';
    _score: number;
  } => Boolean(item));

  matches.sort((left, right) => {
    if (right._score !== left._score) {
      return right._score - left._score;
    }

    return (right.lastMessageDate || 0) - (left.lastMessageDate || 0);
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
    type: getDialogType(currentGlobal, chat),
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
    target: directTarget ? formatMessage(nextGlobal, directTarget) : undefined,
    surroundingMessages: contextMessages.map((message) => formatMessage(nextGlobal, message)),
  };
}

export function getTeleAgentToolDefinitions(): TeleAgentToolDefinition[] {
  return [
    {
      name: 'list_dialogs',
      description: 'Return a page of dialogs sorted by recent activity.',
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
      description: 'Read a page of dialog messages.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['chatId'],
        properties: {
          chatId: { type: 'string', description: 'Dialog chat ID. Required' },
          limit: { type: 'number', description: 'Number of messages to return. Default 10, max 20.' },
          offset: { type: 'number', description: 'Optional local offset for already cached messages.' },
          cursor: { type: 'string', description: 'Opaque cursor returned by a previous read_dialog call.' },
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
      description: 'Search messages by text, optionally within a specific dialog.',
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
          cursor: { type: 'string', description: 'Opaque cursor returned by a previous search_messages call.' },
        },
      },
      execute: executeSearchMessages,
    },
    {
      name: 'get_message_context',
      description: 'Load a target message and a small window around it.',
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
