import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CONVERSATION_MESSAGE_MAX_BYTES,
  CONVERSATION_MESSAGE_MAX_CHARS,
  CONVERSATION_TITLE_MAX_CHARS,
  MAX_CONVERSATION_APPEND,
  deriveConversationTitle,
  isConversationThreadList,
  isConversationTranscript,
  isValidThreadId,
  normalizeConversationAppendInput,
  normalizeConversationMessageInput,
  normalizeConversationTitleInput,
} from '../src/agent-conversation-schema';

class MemoryStorage implements Storage {
  private data = new Map<string, string>();
  get length(): number { return this.data.size; }
  key(index: number): string | null { return [...this.data.keys()][index] ?? null; }
  getItem(key: string): string | null { return this.data.get(key) ?? null; }
  setItem(key: string, value: string): void { this.data.set(key, value); }
  removeItem(key: string): void { this.data.delete(key); }
  clear(): void { this.data.clear(); }
}

beforeEach(() => {
  (globalThis as unknown as { localStorage: Storage }).localStorage = new MemoryStorage();
});
afterEach(() => {
  delete (globalThis as unknown as { localStorage?: Storage }).localStorage;
});

describe('Agent conversation message normalization', () => {
  it('accepts the two persisted roles and trims surrounding whitespace', () => {
    expect(normalizeConversationMessageInput({ role: 'user', content: '  查一下磁盘  ' }))
      .toEqual({ ok: true, value: { role: 'user', content: '查一下磁盘' } });
    expect(normalizeConversationMessageInput({ role: 'assistant', content: '已检查' }))
      .toEqual({ ok: true, value: { role: 'assistant', content: '已检查' } });
  });

  it.each(['system', 'tool', '', null, 1, undefined])('rejects an unsupported role %s', (role) => {
    expect(normalizeConversationMessageInput({ role, content: 'x' }))
      .toEqual({ ok: false, error: 'roleInvalid' });
  });

  it.each(['', '   ', '\n\t'])('rejects blank content %j', (content) => {
    expect(normalizeConversationMessageInput({ role: 'user', content }))
      .toEqual({ ok: false, error: 'contentRequired' });
  });

  it('rejects a non-string content instead of stringifying it', () => {
    expect(normalizeConversationMessageInput({ role: 'user', content: { text: 'x' } }))
      .toEqual({ ok: false, error: 'contentRequired' });
  });

  it('clamps an over-long message to the character limit', () => {
    const long = 'a'.repeat(CONVERSATION_MESSAGE_MAX_CHARS + 50);
    const result = normalizeConversationMessageInput({ role: 'user', content: long });
    expect(result.ok).toBe(true);
    if (result.ok) expect([...result.value.content].length).toBe(CONVERSATION_MESSAGE_MAX_CHARS);
  });

  it('clamps a multi-byte message to the byte limit without splitting code points', () => {
    const long = '中'.repeat(Math.ceil(CONVERSATION_MESSAGE_MAX_BYTES));
    const result = normalizeConversationMessageInput({ role: 'assistant', content: long });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const encoded = new TextEncoder().encode(result.value.content).length;
      expect(encoded).toBeLessThanOrEqual(CONVERSATION_MESSAGE_MAX_BYTES);
      expect(result.value.content).not.toContain('\uFFFD');
    }
  });
});

describe('Agent conversation append batches', () => {
  it('normalizes an ordered batch and preserves the sequence', () => {
    const result = normalizeConversationAppendInput({
      messages: [
        { role: 'user', content: '磁盘满了吗' },
        { role: 'assistant', content: '占用了 92%' },
      ],
    });
    expect(result).toEqual({
      ok: true,
      value: [
        { role: 'user', content: '磁盘满了吗' },
        { role: 'assistant', content: '占用了 92%' },
      ],
    });
  });

  it.each([undefined, null, [], 'x', {}])('rejects a missing or empty batch %j', (messages) => {
    expect(normalizeConversationAppendInput({ messages }))
      .toEqual({ ok: false, error: 'messagesRequired' });
  });

  it('rejects more messages than one append admits', () => {
    const messages = Array.from({ length: MAX_CONVERSATION_APPEND + 1 },
      () => ({ role: 'user', content: 'x' }));
    expect(normalizeConversationAppendInput({ messages }))
      .toEqual({ ok: false, error: 'messagesTooMany' });
  });

  it('rejects a batch when any single message is invalid', () => {
    // 非对象项报 messagesInvalid，角色/正文非法则透传该项的具体错误。
    expect(normalizeConversationAppendInput({
      messages: [{ role: 'user', content: 'ok' }, 'bad'],
    })).toEqual({ ok: false, error: 'messagesInvalid' });
    expect(normalizeConversationAppendInput({
      messages: [{ role: 'user', content: 'ok' }, { role: 'narrator', content: 'bad' }],
    })).toEqual({ ok: false, error: 'roleInvalid' });
  });
});

describe('Conversation thread helpers', () => {
  it('accepts only safe thread ids', () => {
    expect(isValidThreadId('abc12345')).toBe(true);
    expect(isValidThreadId('a-b_c-1234')).toBe(true);
    for (const value of ['', 'short', 'has space here', 'bad/slash/1234', null, 1]) {
      expect(isValidThreadId(value)).toBe(false);
    }
  });

  it('derives a single-line bounded title from the first user message', () => {
    expect(deriveConversationTitle('  检查\n磁盘   使用情况  ')).toBe('检查 磁盘 使用情况');
    expect(deriveConversationTitle('')).toBe('新对话');
    const long = 'a'.repeat(CONVERSATION_TITLE_MAX_CHARS + 10);
    const title = deriveConversationTitle(long);
    expect([...title].length).toBe(CONVERSATION_TITLE_MAX_CHARS + 1);
    expect(title.endsWith('…')).toBe(true);
  });

  it('normalizes a user-supplied rename title', () => {
    expect(normalizeConversationTitleInput('  部署 排查  ')).toEqual({ ok: true, value: '部署 排查' });
    expect(normalizeConversationTitleInput('   ')).toEqual({ ok: false, error: 'titleRequired' });
    expect(normalizeConversationTitleInput(1)).toEqual({ ok: false, error: 'titleRequired' });
    expect(normalizeConversationTitleInput('x'.repeat(CONVERSATION_TITLE_MAX_CHARS + 1)))
      .toEqual({ ok: false, error: 'titleTooLong' });
  });

  it('guards the thread list shell', () => {
    expect(isConversationThreadList({ threads: [], active_thread_id: null })).toBe(true);
    expect(isConversationThreadList({ threads: [{ thread_id: 'a'.repeat(12), title: 't', message_count: 2 }] })).toBe(true);
    for (const value of [null, {}, { threads: 'x' }, { threads: [{ title: 't' }] }]) {
      expect(isConversationThreadList(value)).toBe(false);
    }
  });
});

describe('Conversation transcript guard', () => {
  it('accepts a well-formed transcript and rejects foreign shapes', () => {
    expect(isConversationTranscript({
      thread_id: 'abc12345',
      title: '磁盘排查',
      title_custom: false,
      revision: 3,
      created_at: 1,
      updated_at: 2,
      messages: [{ seq: 1, role: 'user', content: 'hi', created_at: 1 }],
    })).toBe(true);
    for (const value of [null, {}, { messages: 'x' },
      // 缺少线程 id 的旧外壳不再被接受：面板必须知道自己在哪条线程里。
      { messages: [] },
      { thread_id: 'abc12345', messages: [{ role: 'system', content: 'a' }] },
      { thread_id: 'abc12345', messages: [{ role: 'user', content: 1 }] }]) {
      expect(isConversationTranscript(value)).toBe(false);
    }
  });
});
