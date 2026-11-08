import { describe, expect, it, vi } from 'vitest';
import { createAgentMemoryProvider } from '../../src/worker/agent/memory-provider';

/**
 * The provider must keep two request envelopes apart: `/agent-memory` carries
 * `{ user_id, task }`, while `/conversation` carries top-level `messages`
 * (or just `user_id` for a clear). Wrapping the conversation in `task` makes
 * the store reject the append, so a closed panel loses the turn.
 */
function harness() {
  const requests: Array<{ path: string; method: string; body: unknown }> = [];
  const env = {
    USER_DB: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (request: Request) => {
          requests.push({
            path: new URL(request.url).pathname,
            method: request.method,
            body: request.body === null ? undefined : await request.json(),
          });
          return Response.json({ messages: [], revision: 0 });
        },
      }),
    },
  } as never;
  return { env, requests, provider: createAgentMemoryProvider(env, 'gh-1', '7', 5) };
}

describe('Agent memory provider request envelopes', () => {
  it('sends conversation appends with top-level messages', async () => {
    const { provider, requests } = harness();
    await provider.appendConversation([
      { role: 'user', content: '磁盘满了吗' },
      { role: 'assistant', content: '占用 92%' },
    ]);
    expect(requests).toHaveLength(1);
    expect(requests[0].path).toBe('/internal/servers/5/conversation');
    expect(requests[0].method).toBe('POST');
    expect(requests[0].body).toEqual({
      user_id: 7,
      messages: [
        { role: 'user', content: '磁盘满了吗' },
        { role: 'assistant', content: '占用 92%' },
      ],
    });
    expect(requests[0].body).not.toHaveProperty('task');
  });

  it('deletes one thread, or every thread when no id is given', async () => {
    const { provider, requests } = harness();
    await provider.deleteConversation('abc12345');
    expect(requests[0]).toMatchObject({ path: '/internal/servers/5/conversation', method: 'DELETE',
      body: { user_id: 7, thread_id: 'abc12345' } });
    await provider.deleteConversation();
    // 省略 thread_id 表示清空全部线程；JSON.stringify 会丢掉 undefined 字段。
    expect(requests[1]).toMatchObject({ method: 'DELETE', body: { user_id: 7 } });
    expect(requests[1].body).not.toHaveProperty('thread_id');
  });

  it('creates, activates and renames threads through the conversations route', async () => {
    const { provider, requests } = harness();
    await provider.createConversation();
    expect(requests[0]).toMatchObject({ path: '/internal/servers/5/conversations', method: 'POST',
      body: { user_id: 7, action: 'create' } });
    await provider.activateConversation('thread-1234');
    expect(requests[1]).toMatchObject({ body: { user_id: 7, action: 'activate', thread_id: 'thread-1234' } });
    await provider.renameConversation({ thread_id: 'thread-1234', title: '部署排查' });
    expect(requests[2]).toMatchObject({ body: { user_id: 7, action: 'rename', thread_id: 'thread-1234', title: '部署排查' } });
  });

  it('reads one named thread and forwards the id on append', async () => {
    const { provider, requests } = harness();
    await provider.loadConversation('thread-1234');
    expect(requests[0].path).toBe('/internal/servers/5/conversation');
    await provider.appendConversation([{ role: 'user', content: 'x' }], 'thread-1234');
    expect(requests[1]).toMatchObject({ method: 'POST', body: { user_id: 7, thread_id: 'thread-1234' } });
  });

  it('reads the conversation through the user-scoped query', async () => {
    const { provider, requests } = harness();
    await provider.loadConversation();
    expect(requests[0].method).toBe('GET');
    expect(requests[0].path).toBe('/internal/servers/5/conversation');
  });

  it('keeps the distillation task envelope for /agent-memory', async () => {
    const { provider, requests } = harness();
    await provider.enqueueMemory({ taskId: 't1', goal: '部署', conversation: 'c', locale: 'zh-CN', timezone: 'UTC' });
    expect(requests[0].path).toBe('/internal/servers/5/agent-memory');
    expect(requests[0].body).toMatchObject({ user_id: 7, task: { taskId: 't1' } });
  });

  it('uses GET without a body for unified memory', async () => {
    const { provider, requests } = harness();
    await provider.fetchUnifiedMemory();
    expect(requests[0]).toMatchObject({ method: 'GET', body: undefined });
  });

  it('rejects a non-2xx store response so callers can report it', async () => {
    const env = {
      USER_DB: {
        idFromName: (name: string) => name,
        get: () => ({ fetch: async () => Response.json({ error: 'messagesRequired' }, { status: 400 }) }),
      },
    } as never;
    const provider = createAgentMemoryProvider(env, 'gh-1', '7', 5);
    await expect(provider.appendConversation([{ role: 'user', content: 'x' }]))
      .rejects.toMatchObject({ status: 400 });
    vi.restoreAllMocks();
  });
});
