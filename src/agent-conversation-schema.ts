/**
 * Agent 对话线程（Conversation Threads）
 *
 * 每台服务器可以有多条并行的对话线程：面板里的「新建对话」开一条新线程，
 * 旧线程完整保留，可在「会话历史」里重新打开并继续同一段上下文。
 *
 * 与 server-memory-schema 的「工作历程 / 知识」分离：这里保存的是逐条可见问答，
 * 那边保存的是从对话里提炼出的可复用结论。
 */

/** 单台服务器保留的线程数上限；超出后淘汰最久未活动的线程。 */
export const MAX_CONVERSATION_THREADS = 50;
/** 单个线程保留的消息条数上限；超出后丢弃最旧的消息。 */
export const MAX_CONVERSATION_MESSAGES = 200;
/** 单条消息正文上限（按 UTF-16 码点计），超出部分截断。 */
export const CONVERSATION_MESSAGE_MAX_CHARS = 8_000;
/** 单条消息正文的 UTF-8 字节上限。 */
export const CONVERSATION_MESSAGE_MAX_BYTES = 32 * 1024;
/** 一次追加请求允许携带的最大消息条数。 */
export const MAX_CONVERSATION_APPEND = 40;
/** 线程标题上限（服务端自动生成，用户可重命名）。 */
export const CONVERSATION_TITLE_MAX_CHARS = 60;
/** 只接受这两种角色：用户提问与助手回答。 */
export const CONVERSATION_ROLES = ['user', 'assistant'] as const;

export type ConversationRole = (typeof CONVERSATION_ROLES)[number];

export interface ConversationMessage {
  seq: number;
  role: ConversationRole;
  content: string;
  created_at: number;
}

export interface ConversationTranscript {
  /** 线程标识；空线程也有稳定 id。 */
  thread_id: string;
  /** 线程标题（首条用户消息摘要），用户可重命名。 */
  title: string;
  title_custom: boolean;
  messages: ConversationMessage[];
  /** 该线程的写入计数，客户端据此判断是否需要重新拉取。 */
  revision: number;
  created_at: number;
  updated_at: number;
}

/** 「会话历史」列表里的一行。 */
export interface ConversationThreadSummary {
  thread_id: string;
  title: string;
  title_custom: boolean;
  message_count: number;
  preview: string;
  created_at: number;
  updated_at: number;
}

export interface ConversationThreadList {
  threads: ConversationThreadSummary[];
  /** 服务端建议的当前线程（最近活动的）；无线程时为 null。 */
  active_thread_id: string | null;
}

const encoder = new TextEncoder();

function utf8Bytes(text: string): number {
  return encoder.encode(text).length;
}

/** 线程 id 只接受 ASCII 安全字符，避免作为查询参数或存储键时被改写。 */
export function isValidThreadId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(value);
}

/** 生成一个随机线程 id。 */
export function newConversationThreadId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 24);
}

/**
 * 从首条用户消息生成线程标题。
 * @param message 原始消息正文。
 * @returns 单行、截断到上限的标题；空输入返回兜底标题。
 */
export function deriveConversationTitle(message: string): string {
  const single = message.replace(/\s+/g, ' ').trim();
  if (!single) return '新对话';
  const chars = [...single];
  return chars.length > CONVERSATION_TITLE_MAX_CHARS
    ? `${chars.slice(0, CONVERSATION_TITLE_MAX_CHARS).join('')}…`
    : single;
}

/** 规范化用户提交的线程标题。 */
export function normalizeConversationTitleInput(
  value: unknown
): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof value !== 'string') return { ok: false, error: 'titleRequired' };
  const single = value.replace(/\s+/g, ' ').trim();
  if (!single) return { ok: false, error: 'titleRequired' };
  const chars = [...single];
  if (chars.length > CONVERSATION_TITLE_MAX_CHARS) return { ok: false, error: 'titleTooLong' };
  return { ok: true, value: single };
}

function clampContent(text: string): string {
  const chars = [...text];
  let content = chars.length > CONVERSATION_MESSAGE_MAX_CHARS
    ? chars.slice(0, CONVERSATION_MESSAGE_MAX_CHARS).join('')
    : text;
  if (utf8Bytes(content) > CONVERSATION_MESSAGE_MAX_BYTES) {
    let low = 0;
    let high = content.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (utf8Bytes(content.slice(0, mid)) <= CONVERSATION_MESSAGE_MAX_BYTES) low = mid;
      else high = mid - 1;
    }
    content = content.slice(0, low);
  }
  return content;
}

/**
 * 规范化一条待写入的消息。
 * @param input role/content 的原始值；任何一项不合法都返回错误而不是静默丢弃。
 */
export function normalizeConversationMessageInput(
  input: { role?: unknown; content?: unknown }
): { ok: true; value: { role: ConversationRole; content: string } } | { ok: false; error: string } {
  if (typeof input.role !== 'string' || !CONVERSATION_ROLES.includes(input.role as ConversationRole)) {
    return { ok: false, error: 'roleInvalid' };
  }
  if (typeof input.content !== 'string') return { ok: false, error: 'contentRequired' };
  const trimmed = input.content.trim();
  if (!trimmed) return { ok: false, error: 'contentRequired' };
  const content = clampContent(trimmed);
  if (!content.trim()) return { ok: false, error: 'contentRequired' };
  return { ok: true, value: { role: input.role as ConversationRole, content } };
}

/**
 * 规范化一次批量追加请求。
 * @param input 请求体，`messages` 必须是非空数组。
 */
export function normalizeConversationAppendInput(
  input: { messages?: unknown }
): { ok: true; value: Array<{ role: ConversationRole; content: string }> } | { ok: false; error: string } {
  if (!Array.isArray(input.messages) || input.messages.length === 0) {
    return { ok: false, error: 'messagesRequired' };
  }
  if (input.messages.length > MAX_CONVERSATION_APPEND) return { ok: false, error: 'messagesTooMany' };
  const values: Array<{ role: ConversationRole; content: string }> = [];
  for (const item of input.messages) {
    if (!item || typeof item !== 'object') return { ok: false, error: 'messagesInvalid' };
    const normalized = normalizeConversationMessageInput(item as { role?: unknown; content?: unknown });
    if (!normalized.ok) return { ok: false, error: normalized.error };
    values.push(normalized.value);
  }
  return { ok: true, value: values };
}

/** 判断一个值是否是本地缓存的对话记录外壳（客户端校验用，不信任远端形状）。 */
export function isConversationTranscript(value: unknown): value is ConversationTranscript {
  if (!value || typeof value !== 'object') return false;
  const transcript = value as ConversationTranscript;
  if (!Array.isArray(transcript.messages)) return false;
  if (typeof transcript.thread_id !== 'string' || !transcript.thread_id) return false;
  return transcript.messages.every(message => message && typeof message === 'object'
    && typeof message.content === 'string'
    && CONVERSATION_ROLES.includes(message.role));
}

/** 判断一个值是否是「会话历史」列表外壳。 */
export function isConversationThreadList(value: unknown): value is ConversationThreadList {
  if (!value || typeof value !== 'object') return false;
  const list = value as ConversationThreadList;
  return Array.isArray(list.threads) && list.threads.every(thread =>
    thread && typeof thread === 'object'
    && typeof thread.thread_id === 'string'
    && typeof thread.title === 'string'
    && typeof thread.message_count === 'number');
}
