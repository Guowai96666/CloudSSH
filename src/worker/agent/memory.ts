import { CONSECUTIVE_TASK_WINDOW_MS, normalizeKnowledgeInput, normalizeWorkLogInput,
  type UnifiedServerMemory } from '../../server-memory-schema';
import { resolveAIModelBudgets } from '../../ai-model-policy';
import { observation } from './context';
import { parseStructuredReply } from './json-reply';
import { buildFallbackBatch } from './memory-fallback';
import { formatServerMemoryForPrompt, MEMORY_DISTILLATION_PROMPT, MEMORY_FORMAT } from './prompt';
import { ResponsesClient, ResponsesError } from './responses-client';
import type { AgentMemoryBatch, AIConfig, MemoryTask } from './types';

/** One summarization request. Persistence and the three retries belong to UserDBDO. */
export async function distillMemory(config: AIConfig, task: MemoryTask, memory: UnifiedServerMemory,
  signal: AbortSignal): Promise<AgentMemoryBatch> {
  const latest = memory.workLogs[0];
  const recent = latest && Date.now() - latest.updated_at <= CONSECUTIVE_TASK_WINDOW_MS ? [latest] : [];
  const input = JSON.stringify({ goal: task.goal, conversation: task.conversation,
    serverMemory: formatServerMemoryForPrompt({ ...memory, workLogs: recent }, task.locale, Date.now(), task.timezone) });
  const response = await new ResponsesClient(config).create({ purpose: 'memory', stream: false,
    instructions: MEMORY_DISTILLATION_PROMPT + '\nJSON Schema:\n' + JSON.stringify(MEMORY_FORMAT.schema),
    input: [observation('conversation to remember', input)], text: { format: MEMORY_FORMAT },
    reasoning: { effort: 'low' }, max_output_tokens: Math.min(resolveAIModelBudgets(config).max_output_tokens, 8192) }, signal);
  signal.throwIfAborted();
  // 兼容忽略 json_schema 的上游：从 markdown 围栏或正文里取平衡 JSON 对象。
  const value = parseStructuredReply(response.text);
  if (!value) {
    // 仍有上游返回纯自然语言：用保守规则抽取，保证工作历程可用且不污染知识库。
    const fallback = buildFallbackBatch(response.text, recent.length > 0, memory.revision);
    if (!fallback.workLog && (fallback.knowledge?.length ?? 0) === 0) {
      throw new ResponsesError('responses_schema');
    }
    return fallback;
  }
  if (!value || !Object.hasOwn(value, 'workLog') || !Array.isArray(value.knowledge) || value.knowledge.length > 100) {
    throw new ResponsesError('responses_schema');
  }
  const batch: AgentMemoryBatch = { expectedRevision: memory.revision, workLog: null, knowledge: [] };
  if (value.workLog !== null) {
    if (!value.workLog || typeof value.workLog !== 'object') throw new ResponsesError('responses_schema');
    const log = normalizeWorkLogInput(value.workLog);
    if (!log.ok) throw new ResponsesError('responses_schema');
    batch.workLog = { ...log.value, mode: recent.length ? log.value.mode : 'create' };
  }
  const knowledge = new Map<string, NonNullable<AgentMemoryBatch['knowledge']>[number]>();
  for (const item of value.knowledge) {
    if (!item || typeof item !== 'object') throw new ResponsesError('responses_schema');
    const normalized = normalizeKnowledgeInput(item);
    if (!normalized.ok) throw new ResponsesError('responses_schema');
    knowledge.set(normalized.value.key, normalized.value);
  }
  batch.knowledge = [...knowledge.values()];
  return batch;
}
