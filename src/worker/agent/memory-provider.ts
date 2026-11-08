import type { ConversationTranscript } from '../../agent-conversation-schema';
import type { Env } from '../../types';
import { ResponsesError } from './responses-client';
import type { AgentMemoryProvider, ConversationAppendInput, UnifiedServerMemory } from './types';

/**
 * The SSH session only reads memory and submits completed conversation for later summarization.
 *
 * 两条请求形状必须严格区分：`/agent-memory` 收 `{ user_id, task }`，而对话接口
 * 收 `{ user_id, messages }` / `{ user_id }`。把对话也套进 `task` 字段会让服务端
 * 读不到 `messages` 而静默丢弃整轮记录。
 */
export function createAgentMemoryProvider(env: Env, githubId: string, userId: string, serverId: number): AgentMemoryProvider {
  const root = `http://internal/internal/servers/${serverId}`;
  /** Shared transport: one bounded request to this user's UserDBDO. */
  async function send(path: string, init: { method: 'GET' | 'POST' | 'DELETE'; body?: unknown },
    parent?: AbortSignal): Promise<unknown> {
    const controller = new AbortController();
    const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
    const timer = setTimeout(() => controller.abort('memory_timeout'), 10_000);
    let abort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(new ResponsesError('responses_memory_storage'));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
    try {
      return await Promise.race([cancelled, (async () => {
        const stub = env.USER_DB.get(env.USER_DB.idFromName(githubId));
        const response = await stub.fetch(new Request(root + path, { signal,
          method: init.method,
          ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) }));
        if (!response.ok) {
          void response.body?.cancel();
          throw new ResponsesError('responses_memory_storage', response.status);
        }
        return response.json();
      })()]);
    } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
  }
  return {
    fetchUnifiedMemory: async signal =>
      await send(`/memory?user_id=${userId}`, { method: 'GET' }, signal) as UnifiedServerMemory,
    // Unified memory distillation keeps the `task` envelope its store action reads.
    enqueueMemory: async task => { await send('/agent-memory', { method: 'POST', body: { user_id: Number(userId), task } }); },
    loadConversation: async signal =>
      await send(`/conversation?user_id=${userId}`, { method: 'GET' }, signal) as ConversationTranscript,
    // The conversation store reads top-level `messages`; never wrap it in `task`.
    appendConversation: async (messages: ConversationAppendInput[]) => {
      await send('/conversation', { method: 'POST', body: { user_id: Number(userId), messages } });
    },
    clearConversation: async () => {
      await send('/conversation', { method: 'DELETE', body: { user_id: Number(userId) } });
    },
  };
}
