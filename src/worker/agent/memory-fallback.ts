/**
 * 自然语言兜底抽取（Fallback Extraction）
 *
 * 只在模型没有返回可用 JSON 时启用（部分 OpenAI 兼容中转站忽略
 * `text.format = json_schema`，只回中文自然语言）。这里不调用模型，
 * 用保守的模式从总结文本里取出：
 *
 * 1. `workLog`：整段总结（含标题），保证「工作历程」立刻可用；
 * 2. `knowledge`：仅高置信、可确定键名的模式，宁缺毋滥 ——
 *    知识库一旦写入错误内容，后续每轮都会把它注入模型，反而降低会话质量。
 */

import { normalizeKnowledgeInput, type KnowledgeCategory } from '../../server-memory-schema';
import type { AgentMemoryBatch } from './types';

/** 与 server-memory-schema 的 knowledge 校验保持一致的最大条数。 */
const MAX_FALLBACK_KNOWLEDGE = 20;
/** 总结转成 workLog.summary 时的字符上限（与 schema 的 300 一致）。 */
const SUMMARY_MAX_CHARS = 300;
/** 标题字符上限（与 schema 的 64 一致）。 */
const TITLE_MAX_CHARS = 64;

const PATH_PATTERN = /(?:^|[\s`"'(（：:，,；;])((?:~|\.{1,2})?\/[A-Za-z0-9._\-\/]{1,120})/g;
const ENDPOINT_PATTERN = /\b((?:\d{1,3}\.){3}\d{1,3}):(\d{2,5})\b/g;
const KEY_VALUE_PATTERN = /(?:^|[\s，,；;。&])([A-Za-z][A-Za-z0-9_.-]{1,40})[`*]*\s*(?:=|:|＝)\s*[`*]*([^\s，,；;。*`=]{1,200})/g;
const PORT_PATTERN = /(?:端口|port)\s*[:：=]?\s*(\d{2,5})\b/gi;

/** 去掉 markdown 强调/行内代码，保留正文与路径。 */
function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/^[>#\-*\s]+/gm, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/** 压缩成单行并截断到上限。 */
function clampLine(text: string, limit: number): string {
  const single = text.replace(/\s+/g, ' ').trim();
  const chars = [...single];
  return chars.length > limit ? `${chars.slice(0, limit).join('')}…` : single;
}

/**
 * 从总结文本推导 workLog。
 * @param summary 模型给的整段自然语言总结（已去 markdown）。
 * @param continued 是否延续上一条工作记录（同一台服务器 30 分钟内的连续任务）。
 * @returns 可入库的 workLog；文本过短判为「没有实际工作」返回 null。
 */
export function deriveWorkLogFromText(summary: string, continued: boolean):
  { mode: 'create' | 'update_latest'; title: string; summary: string } | null {
  const body = stripMarkdown(summary);
  // 太短，或只有 ASCII 单词（错误串/占位符）而没有实际句子结构与中文，都不算运维总结。
  if ([...body].length < 12) return null;
  if (!/[\u4e00-\u9fa5]/.test(body) && body.split(/\s+/).length < 6) return null;
  const firstLine = body.split(/\n/).map(line => line.trim()).find(line => line.length > 0) ?? body;
  // 标题取首个分句；没有标点时退化为截断。
  const clause = firstLine.split(/[。！？.!?；;：:]/).find(part => part.trim().length >= 2) ?? firstLine;
  return {
    mode: continued ? 'update_latest' : 'create',
    title: clampLine(clause, TITLE_MAX_CHARS) || clampLine(body, TITLE_MAX_CHARS),
    summary: clampLine(body, SUMMARY_MAX_CHARS),
  };
}

/** 判断一个候选值是否像路径/配置，而不是散文。 */
function plausibleValue(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > 200) return false;
  // 纯中文长句不是可复用配置。
  if (/^[\u4e00-\u9fa5，。！？；：\s]+$/.test(trimmed)) return false;
  return /[A-Za-z0-9_./@:-]/.test(trimmed);
}

/**
 * 从总结文本里抽取高置信知识条目。
 * 只处理三类可确定键名的模式：绝对/家目录路径、IP:端口、显式 key=value；
 * 另外把「端口 8080」归一成 `port`。
 * @param summary 总结文本（可含 markdown）。
 * @returns 已通过 `normalizeKnowledgeInput` 校验的条目；上限 MAX_FALLBACK_KNOWLEDGE 条。
 */
export function extractKnowledgeFromText(summary: string):
  Array<{ action: 'set'; category: KnowledgeCategory; key: string; value: string }> {
  const text = stripMarkdown(summary);
  const found = new Map<string, { action: 'set'; category: KnowledgeCategory; key: string; value: string }>();

  const push = (key: string, value: string, category: KnowledgeCategory) => {
    if (found.size >= MAX_FALLBACK_KNOWLEDGE) return;
    if (!plausibleValue(value)) return;
    const normalized = normalizeKnowledgeInput({ action: 'set', category, key, value });
    if (!normalized.ok) return;
    // 同名键只保留第一次出现的值：后续通常是对同一配置的重复描述。
    if (!found.has(normalized.value.key)) {
      found.set(normalized.value.key, {
        action: 'set', category: normalized.value.category, key: normalized.value.key, value: normalized.value.value,
      });
    }
  };

  for (const match of text.matchAll(PATH_PATTERN)) {
    const path = match[1].replace(/[.,;:]$/, '');
    const segments = path.split('/').filter(Boolean);
    const leaf = segments.slice(-2).join('_').replace(/[^A-Za-z0-9_]/g, '_').replace(/_+/g, '_');
    if (!leaf) continue;
    push(`path_${leaf}`.slice(0, 64), path, 'config');
  }

  for (const match of text.matchAll(ENDPOINT_PATTERN)) {
    push(`endpoint_${match[1].replace(/\./g, '_')}`, `${match[1]}:${match[2]}`, 'config');
  }

  // key=value 可能同行连续出现（a=1 b=2），逐个位置扫描比全局 exec 更稳。
  for (const match of text.matchAll(KEY_VALUE_PATTERN)) {
    const key = match[1];
    // 排除「结果：」「说明：」这类中文标签被误认，以及纯数字键位。
    if (/^(?:结果|说明|结论|目标|执行|备注|问题|建议|下一步|状态)$/.test(key)) continue;
    if (/^\d+$/.test(key)) continue;
    push(key, match[2].trim(), 'config');
  }

  for (const match of text.matchAll(PORT_PATTERN)) {
    push('port', match[1], 'config');
  }

  return [...found.values()];
}

/**
 * 把模型回复兜底转成可入库的批次。
 * @param summary 模型回复原文（自然语言/markdown 均可）。
 * @param continued 是否延续上一条工作记录。
 * @param revision 当前记忆版本，用于乐观并发校验。
 * @returns 可入库批次；总结不足以形成 workLog 时 workLog 为 null。
 */
export function buildFallbackBatch(summary: string, continued: boolean, revision?: number): AgentMemoryBatch {
  return {
    expectedRevision: revision,
    workLog: deriveWorkLogFromText(summary, continued),
    knowledge: extractKnowledgeFromText(summary),
  };
}
