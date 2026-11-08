import { describe, expect, it } from 'vitest';
import { parseStructuredReply } from '../../../src/worker/agent/json-reply';

/**
 * 一些 OpenAI 兼容中转站会忽略 `text.format = json_schema`，返回带解释的
 * markdown。解析层必须能从这些回复里取回 JSON 对象，否则整条记忆任务被丢弃。
 */
describe('Structured reply parsing', () => {
  const payload = { workLog: { mode: 'create', title: '部署', summary: '完成部署。' }, knowledge: [] };
  const json = JSON.stringify(payload);

  it('parses a bare JSON object', () => {
    expect(parseStructuredReply(json)).toEqual(payload);
  });

  it('parses JSON wrapped in a ```json fence', () => {
    expect(parseStructuredReply('```json\n' + json + '\n```')).toEqual(payload);
  });

  it('parses JSON wrapped in a bare ``` fence', () => {
    expect(parseStructuredReply('```\n' + json + '\n```')).toEqual(payload);
  });

  it('parses JSON after an explanatory paragraph', () => {
    const reply = `好的，我整理了这次会话：\n\n${json}\n\n以上是结果。`;
    expect(parseStructuredReply(reply)).toEqual(payload);
  });

  it('keeps braces inside JSON strings from confusing the scanner', () => {
    const tricky = { workLog: { mode: 'create', title: '配置', summary: '写了 {"a":1} 这样的模板。' }, knowledge: [] };
    const reply = '说明如下：\n' + JSON.stringify(tricky);
    expect(parseStructuredReply(reply)).toEqual(tricky);
  });

  it('ignores escaped quotes while scanning', () => {
    const tricky = { workLog: null, knowledge: [{ action: 'set', category: 'note', key: 'k', value: 'he said "hi" }' }] };
    expect(parseStructuredReply('前文\n' + JSON.stringify(tricky) + '\n后文')).toEqual(tricky);
  });

  it('returns null for prose without JSON', () => {
    expect(parseStructuredReply('看磁盘，直接给命令。\n\n```bash\ndf -hT\n```')).toBeNull();
  });

  it('returns null for malformed or non-object JSON', () => {
    expect(parseStructuredReply('{"workLog": ')).toBeNull();
    expect(parseStructuredReply('[1,2,3]')).toBeNull();
    expect(parseStructuredReply('')).toBeNull();
    expect(parseStructuredReply(null)).toBeNull();
    expect(parseStructuredReply(42)).toBeNull();
  });

  it('prefers the first complete object when several appear', () => {
    const first = JSON.stringify({ workLog: null, knowledge: [] });
    const second = JSON.stringify({ workLog: null, knowledge: [{ action: 'set', category: 'note', key: 'x', value: 'y' }] });
    expect(parseStructuredReply(`${first}\n${second}`)).toEqual(JSON.parse(first));
  });

  it('tolerates a BOM and zero-width characters before the object', () => {
    expect(parseStructuredReply('\uFEFF\u200B' + json)).toEqual(payload);
  });
});
