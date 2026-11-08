import { CONSECUTIVE_TASK_WINDOW_MS, isSensitiveKeyOrValue, MAX_SERVER_KNOWLEDGE,
  MAX_SERVER_WORK_LOGS, normalizeBatchDeleteKnowledgeInput, normalizeKnowledgeInput,
  normalizeWorkLogInput, type ServerKnowledgeItem, type ServerWorkLog,
  type UnifiedServerMemory } from '../server-memory-schema';
import type { AgentMemoryBatch, MemoryTask } from './agent/types';
import { bytes } from './agent/context-limits';
import {
  MAX_CONVERSATION_MESSAGES, MAX_CONVERSATION_THREADS, deriveConversationTitle, isValidThreadId,
  newConversationThreadId, normalizeConversationAppendInput, normalizeConversationTitleInput,
  type ConversationMessage, type ConversationThreadList, type ConversationTranscript,
} from '../agent-conversation-schema';

class MemoryStoreError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) { super(message); }
}
function storedJSON(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch { /* Report the stored-data error without echoing its content. */ }
  throw new MemoryStoreError(500, 'Invalid saved memory');
}

/** 一条会话线程的存储行。 */
interface ConversationThreadRow {
  thread_id: string; title: string; title_custom: number; message_count: number;
  created_at: number; updated_at: number;
}

export interface PendingMemoryTask {
  user_id: number; server_id: number; task_id: string; payload_enc: string;
  retries: number; next_attempt_at: number;
}
type Knowledge = Extract<ReturnType<typeof normalizeKnowledgeInput>, { ok: true }>['value'] & { encrypted: number };

/** Saved server memory and its small Alarm-backed retry queue. */
export class ServerMemoryStore {
  constructor(private db: SqlStorage, private transaction: <T>(callback: () => T) => T,
    private encrypt: (value: string, userId: number) => Promise<string>,
    private decrypt: (value: string, userId: number) => Promise<string>,
    private scheduleAlarm?: (at: number) => Promise<void>) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_memory_state (
        user_id INTEGER NOT NULL, server_id INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
        scope TEXT NOT NULL DEFAULT '', PRIMARY KEY(user_id, server_id)
      );
      CREATE TABLE IF NOT EXISTS agent_knowledge_meta (
        user_id INTEGER NOT NULL, server_id INTEGER NOT NULL, key TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT '', scope TEXT NOT NULL DEFAULT '', encrypted INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(user_id, server_id, key)
      );
      CREATE TABLE IF NOT EXISTS agent_conversation_threads (
        user_id INTEGER NOT NULL, server_id INTEGER NOT NULL, thread_id TEXT NOT NULL,
        title TEXT NOT NULL, title_custom INTEGER NOT NULL DEFAULT 0,
        message_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY(user_id, server_id, thread_id)
      );
      CREATE TABLE IF NOT EXISTS agent_conversation_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL, server_id INTEGER NOT NULL,
        thread_id TEXT NOT NULL DEFAULT '',
        role TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_conversation_state (
        user_id INTEGER NOT NULL, server_id INTEGER NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0, active_thread_id TEXT NOT NULL DEFAULT '',
        PRIMARY KEY(user_id, server_id)
      );
      CREATE TABLE IF NOT EXISTS agent_pending_distillations (
        user_id INTEGER NOT NULL, server_id INTEGER NOT NULL, task_id TEXT NOT NULL,
        session_id TEXT NOT NULL DEFAULT '', epoch INTEGER NOT NULL DEFAULT 0,
        retries INTEGER NOT NULL DEFAULT 0, payload_enc TEXT NOT NULL, updated_at INTEGER NOT NULL,
        next_attempt_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(user_id, server_id, task_id)
      );
      DROP TABLE IF EXISTS agent_memory_sessions;
      DROP TABLE IF EXISTS agent_task_checkpoints;
      DROP TABLE IF EXISTS agent_execution_logs;
      DROP TABLE IF EXISTS agent_memory_receipts;
    `);
    // 旧版单线程记录升级：补 thread_id 列并把既有消息归入一条历史线程，避免升级即丢历史。
    const messageColumns = this.query<{ name: string }>('PRAGMA table_info(agent_conversation_messages)');
    if (!messageColumns.some(column => column.name === 'thread_id')) {
      db.exec("ALTER TABLE agent_conversation_messages ADD COLUMN thread_id TEXT NOT NULL DEFAULT ''");
      db.exec(`INSERT OR IGNORE INTO agent_conversation_threads(user_id, server_id, thread_id, title, title_custom, message_count, created_at, updated_at)
        SELECT user_id, server_id, 'legacy' || substr(hex(randomblob(4)), 1, 8), '历史对话', 0, 0, MIN(created_at), MAX(created_at)
        FROM agent_conversation_messages GROUP BY user_id, server_id`);
      db.exec(`UPDATE agent_conversation_messages SET thread_id = (
        SELECT thread_id FROM agent_conversation_threads t
        WHERE t.user_id = agent_conversation_messages.user_id AND t.server_id = agent_conversation_messages.server_id
        LIMIT 1) WHERE thread_id = ''`);
    }
    const stateColumns = this.query<{ name: string }>('PRAGMA table_info(agent_conversation_state)');
    if (!stateColumns.some(column => column.name === 'active_thread_id')) {
      db.exec("ALTER TABLE agent_conversation_state ADD COLUMN active_thread_id TEXT NOT NULL DEFAULT ''");
    }
    // Keep old stored credentials/jobs readable; the old source/scope/session columns are no longer used.
    const columns = this.query<{ name: string }>('PRAGMA table_info(agent_pending_distillations)');
    if (!columns.some(column => column.name === 'next_attempt_at')) {
      db.exec('ALTER TABLE agent_pending_distillations ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0');
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_agent_memory_due ON agent_pending_distillations(next_attempt_at)');
  }

  private query<T>(sql: string, ...values: (string | number | null)[]): T[] {
    // SAFETY: each caller specifies the row shape returned by its fixed SELECT statement.
    return this.db.exec(sql, ...values).toArray() as unknown as T[];
  }

  private checkOwner(serverId: number, userId: number): void {
    if (!Number.isSafeInteger(userId) || userId <= 0) throw new MemoryStoreError(400, 'Invalid user_id');
    const server = this.query<{ user_id: number }>('SELECT user_id FROM servers WHERE id = ?', serverId)[0];
    if (!server) throw new MemoryStoreError(404, 'Server not found');
    if (server.user_id !== userId) throw new MemoryStoreError(403, 'Forbidden');
  }

  private revision(serverId: number, userId: number): number {
    this.db.exec("INSERT OR IGNORE INTO agent_memory_state(user_id, server_id, revision, scope) VALUES (?, ?, 0, '')", userId, serverId);
    return this.query<{ revision: number }>('SELECT revision FROM agent_memory_state WHERE user_id = ? AND server_id = ?', userId, serverId)[0]?.revision ?? 0;
  }

  private bump(serverId: number, userId: number): void {
    this.db.exec('UPDATE agent_memory_state SET revision = revision + 1 WHERE user_id = ? AND server_id = ?', userId, serverId);
  }

  private conversationState(serverId: number, userId: number): { revision: number; activeThreadId: string } {
    this.db.exec("INSERT OR IGNORE INTO agent_conversation_state(user_id, server_id, revision, active_thread_id) VALUES (?, ?, 0, '')", userId, serverId);
    const row = this.query<{ revision: number; active_thread_id: string }>(
      'SELECT revision, active_thread_id FROM agent_conversation_state WHERE user_id = ? AND server_id = ?', userId, serverId)[0];
    return row
      ? { revision: row.revision, activeThreadId: row.active_thread_id }
      : { revision: 0, activeThreadId: '' };
  }

  private bumpConversation(serverId: number, userId: number, activeThreadId?: string): void {
    this.conversationState(serverId, userId);
    if (activeThreadId === undefined) {
      this.db.exec('UPDATE agent_conversation_state SET revision = revision + 1 WHERE user_id = ? AND server_id = ?', userId, serverId);
    } else {
      this.db.exec('UPDATE agent_conversation_state SET revision = revision + 1, active_thread_id = ? WHERE user_id = ? AND server_id = ?',
        activeThreadId, userId, serverId);
    }
  }

  private threadRows(serverId: number, userId: number): ConversationThreadRow[] {
    return this.query<ConversationThreadRow>(`SELECT thread_id, title, title_custom, message_count, created_at, updated_at
      FROM agent_conversation_threads WHERE user_id = ? AND server_id = ? ORDER BY updated_at DESC LIMIT ?`,
      userId, serverId, MAX_CONVERSATION_THREADS);
  }

  /** 线程存在性检查；不存在返回 null，避免跨用户/跨服务器读写。 */
  private findThread(serverId: number, userId: number, threadId: string): ConversationThreadRow | null {
    if (!isValidThreadId(threadId)) return null;
    return this.query<ConversationThreadRow>(`SELECT thread_id, title, title_custom, message_count, created_at, updated_at
      FROM agent_conversation_threads WHERE user_id = ? AND server_id = ? AND thread_id = ?`,
      userId, serverId, threadId)[0] ?? null;
  }

  /**
   * 新建一条空线程并设为当前线程。
   * @returns 新线程 id。
   */
  createThread(serverId: number, userId: number, title?: unknown): string {
    this.checkOwner(serverId, userId);
    const custom = title === undefined ? null : normalizeConversationTitleInput(title);
    if (custom && !custom.ok) throw new MemoryStoreError(400, custom.error);
    const threadId = newConversationThreadId();
    const now = Date.now();
    this.transaction(() => {
      this.checkOwner(serverId, userId);
      this.db.exec(`INSERT INTO agent_conversation_threads(user_id, server_id, thread_id, title, title_custom, message_count, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 0, ?, ?)`, userId, serverId, threadId, custom?.value ?? '新对话', custom ? 1 : 0, now, now);
      this.trimThreads(serverId, userId);
      this.bumpConversation(serverId, userId, threadId);
    });
    return threadId;
  }

  /** 列出该服务器的会话历史；建议的当前线程取最近活动的那条。 */
  listThreads(serverId: number, userId: number): ConversationThreadList {
    this.checkOwner(serverId, userId);
    const state = this.conversationState(serverId, userId);
    const threads = this.threadRows(serverId, userId);
    const previews = new Map<string, string>();
    for (const thread of threads) {
      const row = this.query<{ content: string }>(`SELECT content FROM agent_conversation_messages
        WHERE user_id = ? AND server_id = ? AND thread_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1`,
        userId, serverId, thread.thread_id)[0];
      previews.set(thread.thread_id, row ? row.content.replace(/\s+/g, ' ').slice(0, 120) : '');
    }
    return {
      threads: threads.map(thread => ({
        thread_id: thread.thread_id,
        title: thread.title,
        title_custom: thread.title_custom === 1,
        message_count: thread.message_count,
        preview: previews.get(thread.thread_id) ?? '',
        created_at: thread.created_at,
        updated_at: thread.updated_at,
      })),
      active_thread_id: state.activeThreadId && this.findThread(serverId, userId, state.activeThreadId)
        ? state.activeThreadId
        : (threads[0]?.thread_id ?? null),
    };
  }

  /** 把某线程设为当前线程（打开历史会话）。 */
  activateThread(serverId: number, userId: number, threadId: string): void {
    this.checkOwner(serverId, userId);
    if (!this.findThread(serverId, userId, threadId)) throw new MemoryStoreError(404, 'Thread not found');
    this.bumpConversation(serverId, userId, threadId);
  }

  /** 重命名一条线程。 */
  renameThread(serverId: number, userId: number, threadId: string, title: unknown): void {
    const normalized = normalizeConversationTitleInput(title);
    if (!normalized.ok) throw new MemoryStoreError(400, normalized.error);
    this.checkOwner(serverId, userId);
    if (!this.findThread(serverId, userId, threadId)) throw new MemoryStoreError(404, 'Thread not found');
    this.db.exec('UPDATE agent_conversation_threads SET title = ?, title_custom = 1, updated_at = ? WHERE user_id = ? AND server_id = ? AND thread_id = ?',
      normalized.value, Date.now(), userId, serverId, threadId);
    this.bumpConversation(serverId, userId);
  }

  /**
   * 读取一条线程的可见对话。
   * @param threadId 目标线程；省略时读取当前线程，没有任何线程时返回空外壳。
   */
  readConversation(serverId: number, userId: number, threadId?: string): ConversationTranscript {
    this.checkOwner(serverId, userId);
    const state = this.conversationState(serverId, userId);
    const resolved = threadId ?? (state.activeThreadId || this.threadRows(serverId, userId)[0]?.thread_id);
    const thread = resolved ? this.findThread(serverId, userId, resolved) : null;
    if (!thread) {
      return { thread_id: '', title: '', title_custom: false, messages: [],
        revision: state.revision, created_at: 0, updated_at: 0 };
    }
    const rows = this.query<{ id: number; role: string; content: string; created_at: number }>(`SELECT id, role, content, created_at
      FROM agent_conversation_messages WHERE user_id = ? AND server_id = ? AND thread_id = ?
      ORDER BY id DESC LIMIT ?`, userId, serverId, thread.thread_id, MAX_CONVERSATION_MESSAGES);
    const messages: ConversationMessage[] = rows.reverse().map(row => ({
      seq: row.id,
      role: row.role === 'assistant' ? 'assistant' : 'user',
      content: row.content,
      created_at: row.created_at,
    }));
    return {
      thread_id: thread.thread_id,
      title: thread.title,
      title_custom: thread.title_custom === 1,
      messages,
      revision: state.revision,
      created_at: thread.created_at,
      updated_at: thread.updated_at,
    };
  }

  /**
   * 追加若干条消息到指定线程（省略线程时写入当前线程，没有线程则自动新建）。
   * @returns 写入线程 id。
   */
  appendConversation(serverId: number, userId: number, input: { messages?: unknown; thread_id?: unknown }): string {
    const normalized = normalizeConversationAppendInput(input);
    if (!normalized.ok) throw new MemoryStoreError(400, normalized.error);
    this.checkOwner(serverId, userId);
    const requested = input.thread_id === undefined ? undefined : String(input.thread_id);
    if (requested !== undefined && !isValidThreadId(requested)) throw new MemoryStoreError(400, 'threadInvalid');
    const now = Date.now();
    return this.transaction(() => {
      this.checkOwner(serverId, userId);
      const state = this.conversationState(serverId, userId);
      let threadId = requested ?? (state.activeThreadId || this.threadRows(serverId, userId)[0]?.thread_id);
      if (!threadId || !this.findThread(serverId, userId, threadId)) {
        // 没有可用线程：自动开一条，标题取首条用户消息。
        threadId = newConversationThreadId();
        const firstUser = normalized.value.find(message => message.role === 'user');
        this.db.exec(`INSERT INTO agent_conversation_threads(user_id, server_id, thread_id, title, title_custom, message_count, created_at, updated_at)
          VALUES (?, ?, ?, ?, 0, 0, ?, ?)`, userId, serverId, threadId,
          deriveConversationTitle(firstUser?.content ?? ''), now, now);
      }
      for (const message of normalized.value) {
        this.db.exec('INSERT INTO agent_conversation_messages(user_id, server_id, thread_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          userId, serverId, threadId, message.role, message.content, now);
      }
      this.db.exec(`DELETE FROM agent_conversation_messages WHERE user_id = ? AND server_id = ? AND thread_id = ? AND id NOT IN (
        SELECT id FROM agent_conversation_messages WHERE user_id = ? AND server_id = ? AND thread_id = ?
        ORDER BY id DESC LIMIT ?)`, userId, serverId, threadId, userId, serverId, threadId, MAX_CONVERSATION_MESSAGES);
      const count = this.query<{ n: number }>('SELECT COUNT(*) AS n FROM agent_conversation_messages WHERE user_id = ? AND server_id = ? AND thread_id = ?',
        userId, serverId, threadId)[0]?.n ?? normalized.value.length;
      const firstUser = normalized.value.find(message => message.role === 'user');
      this.db.exec(`UPDATE agent_conversation_threads SET message_count = ?, updated_at = ?,
        title = CASE WHEN title_custom = 0 THEN ? ELSE title END
        WHERE user_id = ? AND server_id = ? AND thread_id = ?`,
        count, now, deriveConversationTitle(firstUser?.content ?? ''), userId, serverId, threadId);
      this.trimThreads(serverId, userId);
      this.bumpConversation(serverId, userId, threadId);
      return threadId;
    });
  }

  /** 删除一条线程（含其消息）；删除当前线程后当前线程切到最近活动的另一条。 */
  deleteThread(serverId: number, userId: number, threadId: string): void {
    this.checkOwner(serverId, userId);
    if (!this.findThread(serverId, userId, threadId)) throw new MemoryStoreError(404, 'Thread not found');
    this.transaction(() => {
      this.db.exec('DELETE FROM agent_conversation_messages WHERE user_id = ? AND server_id = ? AND thread_id = ?',
        userId, serverId, threadId);
      this.db.exec('DELETE FROM agent_conversation_threads WHERE user_id = ? AND server_id = ? AND thread_id = ?',
        userId, serverId, threadId);
      const next = this.threadRows(serverId, userId)[0]?.thread_id ?? '';
      this.bumpConversation(serverId, userId, next);
    });
  }

  /** 清空该服务器的全部对话线程（服务器删除时调用）。 */
  clearAllConversations(serverId: number, userId: number): void {
    this.checkOwner(serverId, userId);
    this.transaction(() => {
      this.db.exec('DELETE FROM agent_conversation_messages WHERE user_id = ? AND server_id = ?', userId, serverId);
      this.db.exec('DELETE FROM agent_conversation_threads WHERE user_id = ? AND server_id = ?', userId, serverId);
      this.bumpConversation(serverId, userId, '');
    });
  }

  private trimThreads(serverId: number, userId: number): void {
    this.db.exec(`DELETE FROM agent_conversation_messages WHERE user_id = ? AND server_id = ? AND thread_id NOT IN (
      SELECT thread_id FROM agent_conversation_threads WHERE user_id = ? AND server_id = ?
      ORDER BY updated_at DESC LIMIT ?)`, userId, serverId, userId, serverId, MAX_CONVERSATION_THREADS);
    this.db.exec(`DELETE FROM agent_conversation_threads WHERE user_id = ? AND server_id = ? AND thread_id NOT IN (
      SELECT thread_id FROM agent_conversation_threads WHERE user_id = ? AND server_id = ?
      ORDER BY updated_at DESC LIMIT ?)`, userId, serverId, userId, serverId, MAX_CONVERSATION_THREADS);
  }

  async read(serverId: number, userId: number): Promise<UnifiedServerMemory> {
    this.checkOwner(serverId, userId);
    const revision = this.revision(serverId, userId);
    const workLogs = this.query<ServerWorkLog>(`SELECT id, user_id, server_id, title, summary, created_at, updated_at
      FROM server_work_logs WHERE server_id = ? AND user_id = ? ORDER BY updated_at DESC, id DESC LIMIT ?`, serverId, userId, MAX_SERVER_WORK_LOGS);
    const knowledge = this.query<ServerKnowledgeItem>(`SELECT id, user_id, server_id, category, key, value, created_at, updated_at
      FROM server_knowledge WHERE server_id = ? AND user_id = ? ORDER BY updated_at DESC, id DESC LIMIT ?`, serverId, userId, MAX_SERVER_KNOWLEDGE);
    const encrypted = new Set(this.query<{ key: string; encrypted: number }>(
      'SELECT key, encrypted FROM agent_knowledge_meta WHERE user_id = ? AND server_id = ?', userId, serverId)
      .filter(item => item.encrypted).map(item => item.key));
    for (const item of knowledge) if (encrypted.has(item.key)) {
      const stored = storedJSON(await this.decrypt(item.value, userId));
      if (stored.purpose !== 'server-knowledge' || stored.serverId !== serverId || stored.key !== item.key || typeof stored.value !== 'string') {
        throw new MemoryStoreError(500, 'Invalid saved knowledge');
      }
      item.value = stored.value;
    }
    return { workLogs, knowledge, revision };
  }

  private async prepareKnowledge(serverId: number, userId: number, input: Parameters<typeof normalizeKnowledgeInput>[0]): Promise<Knowledge> {
    const value = normalizeKnowledgeInput(input);
    if (!value.ok) throw new MemoryStoreError(400, value.error);
    const encrypted = value.value.action === 'set' && (value.value.category === 'credential' || isSensitiveKeyOrValue(value.value.key, value.value.value)) ? 1 : 0;
    return { ...value.value, encrypted, value: encrypted ? await this.encrypt(JSON.stringify({ purpose: 'server-knowledge',
      serverId, key: value.value.key, value: value.value.value }), userId) : value.value.value };
  }

  private writeKnowledge(serverId: number, userId: number, item: Knowledge): void {
    if (item.action === 'delete') {
      this.db.exec('DELETE FROM server_knowledge WHERE user_id = ? AND server_id = ? AND key = ?', userId, serverId, item.key);
      this.db.exec('DELETE FROM agent_knowledge_meta WHERE user_id = ? AND server_id = ? AND key = ?', userId, serverId, item.key);
      return;
    }
    const now = Date.now();
    this.db.exec(`INSERT INTO server_knowledge(user_id, server_id, category, key, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, server_id, key) DO UPDATE SET category = excluded.category, value = excluded.value, updated_at = excluded.updated_at`,
      userId, serverId, item.category, item.key, item.value, now, now);
    this.db.exec(`INSERT INTO agent_knowledge_meta(user_id, server_id, key, source, scope, encrypted) VALUES (?, ?, ?, '', '', ?)
      ON CONFLICT(user_id, server_id, key) DO UPDATE SET encrypted = excluded.encrypted`, userId, serverId, item.key, item.encrypted);
  }

  private writeLog(serverId: number, userId: number, log: { title: string; summary: string; mode?: string }): void {
    const latest = log.mode === 'update_latest' ? this.query<{ id: number; updated_at: number }>(
      'SELECT id, updated_at FROM server_work_logs WHERE server_id = ? AND user_id = ? ORDER BY updated_at DESC, id DESC LIMIT 1', serverId, userId)[0] : undefined;
    const now = Date.now();
    if (latest && now - latest.updated_at <= CONSECUTIVE_TASK_WINDOW_MS) {
      this.db.exec('UPDATE server_work_logs SET title = ?, summary = ?, updated_at = ? WHERE id = ? AND user_id = ? AND server_id = ?',
        log.title, log.summary, now, latest.id, userId, serverId);
    } else {
      this.db.exec('INSERT INTO server_work_logs(user_id, server_id, title, summary, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        userId, serverId, log.title, log.summary, now, now);
    }
  }

  private trim(serverId: number, userId: number): void {
    this.db.exec(`DELETE FROM server_work_logs WHERE server_id = ? AND user_id = ? AND id NOT IN (
      SELECT id FROM server_work_logs WHERE server_id = ? AND user_id = ? ORDER BY updated_at DESC, id DESC LIMIT ?)`, serverId, userId, serverId, userId, MAX_SERVER_WORK_LOGS);
    this.db.exec(`DELETE FROM server_knowledge WHERE server_id = ? AND user_id = ? AND id NOT IN (
      SELECT id FROM server_knowledge WHERE server_id = ? AND user_id = ? ORDER BY updated_at DESC, id DESC LIMIT ?)`, serverId, userId, serverId, userId, MAX_SERVER_KNOWLEDGE);
    this.db.exec(`DELETE FROM agent_knowledge_meta WHERE user_id = ? AND server_id = ? AND key NOT IN (
      SELECT key FROM server_knowledge WHERE user_id = ? AND server_id = ?)`, userId, serverId, userId, serverId);
  }

  async saveBatch(serverId: number, userId: number, batch: AgentMemoryBatch,
    task?: PendingMemoryTask, signal?: AbortSignal): Promise<void> {
    this.checkOwner(serverId, userId);
    const raw = batch.knowledge ?? [];
    if (!Array.isArray(raw) || raw.length > 100) throw new MemoryStoreError(400, 'Invalid knowledge batch');
    const knowledge = await Promise.all(raw.map(item => this.prepareKnowledge(serverId, userId, item)));
    const log = batch.workLog ? normalizeWorkLogInput(batch.workLog) : null;
    if (log && !log.ok) throw new MemoryStoreError(400, log.error);
    this.transaction(() => {
      signal?.throwIfAborted();
      this.checkOwner(serverId, userId);
      if (task) {
        const current = this.query<PendingMemoryTask>('SELECT retries, next_attempt_at FROM agent_pending_distillations WHERE user_id = ? AND server_id = ? AND task_id = ?', userId, serverId, task.task_id)[0];
        if (!current || current.retries !== task.retries || current.next_attempt_at !== task.next_attempt_at || Date.now() >= task.next_attempt_at) {
          throw new MemoryStoreError(409, 'Task already handled');
        }
      }
      const revision = this.revision(serverId, userId);
      if (batch.expectedRevision !== undefined && batch.expectedRevision !== revision) {
        throw new MemoryStoreError(409, 'Memory changed', 'memory_revision_conflict');
      }
      for (const item of knowledge) this.writeKnowledge(serverId, userId, item);
      if (log?.ok) this.writeLog(serverId, userId, log.value);
      this.trim(serverId, userId); this.bump(serverId, userId);
      if (task) this.db.exec('DELETE FROM agent_pending_distillations WHERE user_id = ? AND server_id = ? AND task_id = ?', userId, serverId, task.task_id);
    });
  }

  private deleteKnowledge(serverId: number, userId: number, id: number): void {
    const row = this.query<{ key: string }>('SELECT key FROM server_knowledge WHERE id = ? AND server_id = ? AND user_id = ?', id, serverId, userId)[0];
    this.db.exec('DELETE FROM server_knowledge WHERE id = ? AND server_id = ? AND user_id = ?', id, serverId, userId);
    if (row) this.db.exec('DELETE FROM agent_knowledge_meta WHERE user_id = ? AND server_id = ? AND key = ?', userId, serverId, row.key);
  }

  async handle(serverId: number, action: string, request: Request, itemId?: number): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (request.method === 'GET' && action === 'memory') return Response.json(await this.read(serverId, Number(url.searchParams.get('user_id'))));
      if (request.method === 'GET' && action === 'conversation') {
        const userId = Number(url.searchParams.get('user_id'));
        const threadId = url.searchParams.get('thread') ?? undefined;
        if (threadId !== undefined && !isValidThreadId(threadId)) {
          return Response.json({ error: 'threadInvalid', code: 'threadInvalid' }, { status: 400 });
        }
        return Response.json(this.readConversation(serverId, userId, threadId));
      }
      if (request.method === 'GET' && action === 'conversations') {
        return Response.json(this.listThreads(serverId, Number(url.searchParams.get('user_id'))));
      }
      if (request.method === 'DELETE' && action === 'conversation') {
        // 删除单条线程或清空全部：按 body 里的 user_id 鉴权，与其它批量接口一致。
        const body = await request.json<Record<string, unknown>>().catch(() => null);
        const userId = Number(body?.user_id);
        const threadId = typeof body?.thread_id === 'string' ? body.thread_id : '';
        if (threadId) this.deleteThread(serverId, userId, threadId);
        else this.clearAllConversations(serverId, userId);
        return Response.json({ success: true });
      }
      if (request.method === 'DELETE' && action !== 'knowledge-batch') {
        const userId = Number(url.searchParams.get('user_id'));
        this.checkOwner(serverId, userId); this.revision(serverId, userId);
        this.transaction(() => {
          if (action === 'work-log') this.db.exec('DELETE FROM server_work_logs WHERE id = ? AND server_id = ? AND user_id = ?', itemId!, serverId, userId);
          else this.deleteKnowledge(serverId, userId, itemId!);
          this.bump(serverId, userId);
        });
        return Response.json({ success: true });
      }
      const body = await request.json<Record<string, unknown>>();
      const userId = Number(body.user_id);
      this.checkOwner(serverId, userId);
      if (action === 'conversation-append') {
        const threadId = this.appendConversation(serverId, userId, { messages: body.messages, thread_id: body.thread_id });
        return Response.json({ success: true, thread_id: threadId,
          revision: this.conversationState(serverId, userId).revision }, { status: 201 });
      }
      if (action === 'conversation-thread') {
        const threadId = this.createThread(serverId, userId, body.title);
        return Response.json({ success: true, thread_id: threadId }, { status: 201 });
      }
      if (action === 'conversation-activate') {
        if (typeof body.thread_id !== 'string') throw new MemoryStoreError(400, 'threadRequired');
        this.activateThread(serverId, userId, body.thread_id);
        return Response.json({ success: true });
      }
      if (action === 'conversation-rename') {
        if (typeof body.thread_id !== 'string') throw new MemoryStoreError(400, 'threadRequired');
        this.renameThread(serverId, userId, body.thread_id, body.title);
        return Response.json({ success: true });
      }
      if (action === 'task') {
        await this.enqueueMemory(serverId, userId, body.task as MemoryTask);
        return Response.json({ success: true });
      }
      if (action === 'knowledge-batch') {
        const ids = normalizeBatchDeleteKnowledgeInput(body);
        if (!ids.ok) throw new MemoryStoreError(400, ids.error);
        this.revision(serverId, userId);
        this.transaction(() => {
          for (const id of ids.value.ids) this.deleteKnowledge(serverId, userId, id);
          this.bump(serverId, userId);
        });
        return Response.json({ success: true, count: ids.value.ids.length });
      }
      if (action === 'knowledge') {
        const key = normalizeKnowledgeInput(body);
        if (!key.ok) throw new MemoryStoreError(400, key.error);
        await this.saveBatch(serverId, userId, { knowledge: [key.value] });
        const saved = this.query<ServerKnowledgeItem>('SELECT id, user_id, server_id, category, key, value, created_at, updated_at FROM server_knowledge WHERE server_id = ? AND user_id = ? AND key = ?',
          serverId, userId, key.value.key)[0];
        return Response.json(saved ? { ...saved, value: key.value.value } : { success: true }, { status: 201 });
      }
      if (action === 'work-log') {
        await this.saveBatch(serverId, userId, { workLog: body as AgentMemoryBatch['workLog'] });
        const saved = this.query<ServerWorkLog>('SELECT id, user_id, server_id, title, summary, created_at, updated_at FROM server_work_logs WHERE server_id = ? AND user_id = ? ORDER BY updated_at DESC, id DESC LIMIT 1', serverId, userId)[0];
        return Response.json(saved, { status: 201 });
      }
      throw new MemoryStoreError(404, 'Unknown memory action');
    } catch (error) {
      if (error instanceof MemoryStoreError) return Response.json({ error: error.message, code: error.code }, { status: error.status });
      return Response.json({ error: 'Memory storage failed' }, { status: 500 });
    }
  }

  async enqueueMemory(serverId: number, userId: number, task: MemoryTask): Promise<void> {
    if (!task || typeof task.taskId !== 'string' || !task.taskId || task.taskId.length > 128 ||
      typeof task.goal !== 'string' || typeof task.conversation !== 'string' || bytes(task) > 128 * 1024) {
      throw new MemoryStoreError(400, 'Invalid memory task');
    }
    this.checkOwner(serverId, userId);
    const payload = await this.encrypt(JSON.stringify({ purpose: 'pending-distillation', serverId, job: task }), userId);
    this.checkOwner(serverId, userId);
    this.db.exec(`INSERT OR IGNORE INTO agent_pending_distillations(user_id, server_id, task_id, session_id, epoch, retries, payload_enc, updated_at, next_attempt_at)
      VALUES (?, ?, ?, '', 0, 0, ?, ?, ?)`, userId, serverId, task.taskId, payload, Date.now(), Date.now());
    await this.rearm();
  }

  /** Reserve one due row by advancing its wake time, so a crash also has a scheduled retry. */
  nextTask(): PendingMemoryTask | undefined {
    return this.transaction(() => {
      const now = Date.now();
      this.db.exec('DELETE FROM agent_pending_distillations WHERE retries >= 4 AND next_attempt_at <= ?', now);
      const row = this.query<PendingMemoryTask>('SELECT * FROM agent_pending_distillations WHERE next_attempt_at <= ? ORDER BY updated_at, task_id LIMIT 1', now)[0];
      if (!row) return;
      row.retries++; row.next_attempt_at = now + 30_000;
      this.db.exec('UPDATE agent_pending_distillations SET retries = ?, next_attempt_at = ? WHERE user_id = ? AND server_id = ? AND task_id = ?',
        row.retries, row.next_attempt_at, row.user_id, row.server_id, row.task_id);
      return row;
    });
  }

  async taskInput(row: PendingMemoryTask): Promise<MemoryTask> {
    this.checkOwner(row.server_id, row.user_id);
    const payload = storedJSON(await this.decrypt(row.payload_enc, row.user_id));
    if (payload.purpose !== 'pending-distillation' || payload.serverId !== row.server_id ||
      !payload.job || typeof payload.job !== 'object') throw new MemoryStoreError(400, 'Invalid memory task');
    const job = payload.job as Record<string, unknown>;
    // Read old failed jobs without restoring the old configuration or auxiliary evidence machinery.
    return { taskId: row.task_id, goal: String(job.goal ?? ''),
      conversation: typeof job.conversation === 'string' ? job.conversation : JSON.stringify(job.records ?? []),
      locale: job.locale === 'en-US' || job.locale === 'zh-TW' ? job.locale : 'zh-CN',
      timezone: typeof job.timezone === 'string' ? job.timezone : 'UTC' };
  }

  retryTask(row: PendingMemoryTask): void {
    if (row.retries >= 4) this.db.exec('DELETE FROM agent_pending_distillations WHERE user_id = ? AND server_id = ? AND task_id = ? AND retries = ?', row.user_id, row.server_id, row.task_id, row.retries);
    else this.db.exec('UPDATE agent_pending_distillations SET next_attempt_at = ? WHERE user_id = ? AND server_id = ? AND task_id = ? AND retries = ?',
      Date.now() + 2000 * 2 ** (row.retries - 1), row.user_id, row.server_id, row.task_id, row.retries);
  }

  async rearm(): Promise<void> {
    const row = this.query<{ due: number | null }>('SELECT MIN(next_attempt_at) AS due FROM agent_pending_distillations')[0];
    if (row?.due != null && this.scheduleAlarm) await this.scheduleAlarm(Math.max(Date.now() + 1, row.due));
  }

  cleanup(serverId: number): void {
    this.db.exec('DELETE FROM agent_memory_state WHERE server_id = ?', serverId);
    this.db.exec('DELETE FROM agent_knowledge_meta WHERE server_id = ?', serverId);
    this.db.exec('DELETE FROM agent_pending_distillations WHERE server_id = ?', serverId);
    this.db.exec('DELETE FROM agent_conversation_messages WHERE server_id = ?', serverId);
    this.db.exec('DELETE FROM agent_conversation_threads WHERE server_id = ?', serverId);
    this.db.exec('DELETE FROM agent_conversation_state WHERE server_id = ?', serverId);
  }
}
