/**
 * 从模型回复里取出结构化 JSON 的自愈解析。
 *
 * 只支持 `text.format = json_schema` 的上游会直接返回 JSON；大量中转站/兼容实现
 * 会忽略该字段，返回带解释的 markdown（甚至把 JSON 包在 ```json 围栏里）。
 * 这里把「回复里存在可解析的 JSON 对象」与「回复完全不是 JSON」区分开，
 * 前者正常入库，后者才让任务重试。
 */

const FENCE = /```(?:json|JSON)?\s*([\s\S]*?)(?:```|$)/g;

/** 去掉首尾空白与非 JSON 前缀（BOM、零宽字符）。 */
function tidy(text: string): string {
  return text.replace(/^\uFEFF/, '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
}

/** 扫描一个以 `start` 开头的平衡花括号片段；字符串内的括号不计数。 */
function balancedObjectAt(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char === '{') depth++;
    else if (char === '}') {
      depth--;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

/** 收集候选片段：整段、``` 围栏内容、每个顶层 `{...}`。 */
function candidates(text: string): string[] {
  const body = tidy(text);
  const found: string[] = [body];
  for (const match of body.matchAll(FENCE)) {
    const inner = tidy(match[1] ?? '');
    if (inner) found.push(inner);
  }
  for (let index = body.indexOf('{'); index !== -1; index = body.indexOf('{', index + 1)) {
    const object = balancedObjectAt(body, index);
    if (object) found.push(object);
  }
  return [...new Set(found)];
}

/**
 * 解析模型回复中的 JSON 对象。
 * @param text 原始回复正文。
 * @returns 解析出的普通对象；找不到任何 JSON 对象时返回 null（调用方据此决定是否重试）。
 */
export function parseStructuredReply(text: unknown): Record<string, unknown> | null {
  if (typeof text !== 'string') return null;
  for (const candidate of candidates(text)) {
    if (!candidate.startsWith('{') && !candidate.startsWith('[')) continue;
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch { /* 继续尝试下一个候选片段 */ }
  }
  return null;
}
