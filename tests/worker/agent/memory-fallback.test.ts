import { describe, expect, it } from 'vitest';
import {
  buildFallbackBatch, deriveWorkLogFromText, extractKnowledgeFromText,
} from '../../../src/worker/agent/memory-fallback';

/**
 * 兜底只在模型回自然语言时启用。目标：工作历程可用，知识库只收高置信条目，
 * 宁缺毋滥 —— 写错的配置会被后续每轮注入模型，反而降低会话质量。
 */
describe('Fallback work log derivation', () => {
  it('turns a markdown summary into a bounded title and summary', () => {
    const text = '**磁盘现状（来自那次 df -h 回显）**\n\n| 挂载点 | 总量 |\n|---|---|\n| `/` | 20G |\n\n剩余可用只有 2G，建议清理日志。';
    const log = deriveWorkLogFromText(text, false);
    expect(log).not.toBeNull();
    expect(log?.mode).toBe('create');
    expect(log?.title).toContain('磁盘现状');
    expect([...(log?.summary ?? '')].length).toBeLessThanOrEqual(301);
    expect(log?.summary).not.toContain('**');
  });

  it('marks a continuation as update_latest', () => {
    const log = deriveWorkLogFromText('继续排查 nginx 配置，确认 upstream 指向 127.0.0.1:8080。', true);
    expect(log?.mode).toBe('update_latest');
  });

  it('rejects a summary too short to be real work', () => {
    expect(deriveWorkLogFromText('好的。', false)).toBeNull();
    expect(deriveWorkLogFromText('', false)).toBeNull();
    expect(deriveWorkLogFromText('   \n  ', false)).toBeNull();
  });
});

describe('Fallback knowledge extraction', () => {
  it('extracts absolute paths as config entries', () => {
    const items = extractKnowledgeFromText('日志在 `/var/log/nginx/error.log`，配置在 /etc/nginx/nginx.conf。');
    const values = items.map(item => item.value);
    expect(values).toContain('/var/log/nginx/error.log');
    expect(values).toContain('/etc/nginx/nginx.conf');
    expect(items.every(item => item.category === 'config')).toBe(true);
  });

  it('extracts ip:port endpoints', () => {
    const items = extractKnowledgeFromText('上游地址是 10.0.3.7:8080，备份机 192.168.1.20:22。');
    const values = items.map(item => item.value);
    expect(values).toContain('10.0.3.7:8080');
    expect(values).toContain('192.168.1.20:22');
  });

  it('extracts explicit key=value pairs but skips chinese prose labels', () => {
    const items = extractKnowledgeFromText('结果：目录已清理。max_connections = 512\nworker_processes=4');
    const keys = items.map(item => item.key);
    expect(keys).toContain('max_connections');
    expect(keys).toContain('worker_processes');
    expect(keys).not.toContain('结果');
  });

  it('normalizes a stated port into a single port entry', () => {
    const items = extractKnowledgeFromText('服务监听端口 8443。');
    expect(items).toEqual([{ action: 'set', category: 'config', key: 'port', value: '8443' }]);
  });

  it('never fabricates entries from pure prose', () => {
    expect(extractKnowledgeFromText('我把日志清理了一下，现在空间恢复正常，没有别的问题。')).toEqual([]);
  });

  it('keeps the first value when a key repeats, and caps the batch', () => {
    const repeated = extractKnowledgeFromText('listen_port = 80\nlisten_port = 8080');
    expect(repeated.filter(item => item.key === 'listen_port')).toHaveLength(1);
    expect(repeated[0].value).toBe('80');

    const many = Array.from({ length: 40 }, (_v, i) => `key_${i} = value_${i}`).join('\n');
    expect(extractKnowledgeFromText(many).length).toBeLessThanOrEqual(20);
  });

  it('does not emit credentials that were not stated as key=value', () => {
    // 散文里的密码不会被抽走：宁可漏，不可错存。
    expect(extractKnowledgeFromText('我把密码改成了别的。')).toEqual([]);
  });
});

describe('Fallback batch assembly', () => {
  it('combines workLog and knowledge with the expected revision', () => {
    const batch = buildFallbackBatch('部署 nginx 到 /etc/nginx，端口 8080，已完成并验证。', false, 7);
    expect(batch.expectedRevision).toBe(7);
    expect(batch.workLog?.title).toContain('部署 nginx');
    expect(batch.knowledge?.map(item => item.value)).toContain('8080');
  });

  it('returns a null workLog when the text is not real work', () => {
    const batch = buildFallbackBatch('嗯。', false, 1);
    expect(batch.workLog).toBeNull();
    expect(batch.knowledge).toEqual([]);
  });
});
