/**
 * Agent 对话记录（Conversation Transcript）
 *
 * 与 server-memory-schema 的“工作历程 / 知识”分离：这里保存的是用户与 AI 助手的
 * 逐条可见对话，用于关闭面板、切换页面或重连之后恢复同一段对话上下文。
 * 只保存正文文本，不保存工具调用、终端快照或审批结果。
 */

/** 单个会话保留的最大消息条数；超出后丢弃最旧的消息。 */
export const MAX_CONVERSATION_MESSAGES = 200;
/** 单条消息正文上限（按 UTF-16 码点计），超出部分截断。 */
export const CONVERSATION_MESSAGE_MAX_CHARS = 8_000;
/** 一次追加请求允许携带的最大消息条数。 */
export const MAX_CONVERSATION_APPEND = 40;
/** 单条消息正文的 UTF-8 字节上限，避免一条超长消息撑爆存储。 */
export const CONVERSATION_MESSAGE_MAX_BYTES = 32 * 1024;
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
  messages: ConversationMessage[];
  /** 服务端单调递增的写入计数；客户端用它判断是否需要重新拉取。 */
  revision: number;
}

const encoder = new TextEncoder();

function utf8Bytes(text: string): number {
  return encoder.encode(text).length;
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
  const chars = [...trimmed];
  let content = chars.length > CONVERSATION_MESSAGE_MAX_CHARS
    ? chars.slice(0, CONVERSATION_MESSAGE_MAX_CHARS).join('')
    : trimmed;
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
  return transcript.messages.every(message => message && typeof message === 'object'
    && typeof message.content === 'string'
    && CONVERSATION_ROLES.includes(message.role));
}
