import { describe, expect, it } from 'vitest';
import {
  AGENT_EXECUTION_MODES, DEFAULT_AGENT_EXECUTION_MODE, decideExecution,
  isReadOnlyCommand, normalizeAgentExecutionMode,
} from '../src/agent-execution-mode';

/**
 * 三档执行模式是安全边界的一部分：观察模式必须真的只读，确认模式不能放过写操作，
 * 自动模式也仍然不能绕过 safety.ts 的硬拦截。
 */
describe('Execution mode normalization', () => {
  it('accepts exactly the three documented modes', () => {
    expect(AGENT_EXECUTION_MODES).toEqual(['auto', 'confirm', 'observe']);
    for (const mode of AGENT_EXECUTION_MODES) expect(normalizeAgentExecutionMode(mode)).toBe(mode);
  });

  it('falls back to confirm for unknown or missing values instead of widening access', () => {
    expect(DEFAULT_AGENT_EXECUTION_MODE).toBe('confirm');
    for (const value of [undefined, null, '', 'interactive', 'AUTO', 1, {}]) {
      expect(normalizeAgentExecutionMode(value)).toBe('confirm');
    }
  });
});

describe('Read-only command detection', () => {
  it('treats common inspection commands as read-only', () => {
    for (const command of [
      'ls -la', 'df -h', 'free -m', 'cat /etc/os-release', 'ps aux', 'ss -lntp',
      'systemctl status nginx', 'docker ps', 'uptime', 'grep -r foo /etc',
      'sudo df -h', 'journalctl -u nginx --no-pager', '/usr/bin/df -h',
    ]) {
      expect(isReadOnlyCommand(command), command).toBe(true);
    }
  });

  it('classifies any state-changing command as a write', () => {
    for (const command of [
      'rm -rf /tmp/x', 'apt-get install nginx', 'systemctl restart nginx',
      'docker rm -f web', 'echo hi > /tmp/a', 'cat /etc/passwd >> /tmp/a',
      'mkdir /tmp/x', 'chmod 777 /tmp/a', 'kill -9 1234', 'npm install',
      'cp a b', 'useradd bob', 'crontab -e', 'tee /etc/hosts',
      'mysql -e "delete from t"', 'git push', 'find / -delete',
    ]) {
      expect(isReadOnlyCommand(command), command).toBe(false);
    }
  });

  it('rejects command substitution and heredocs, which cannot be statically proven read-only', () => {
    expect(isReadOnlyCommand('ls $(rm -rf /tmp/x)')).toBe(false);
    expect(isReadOnlyCommand('cat `cat /tmp/cmd`')).toBe(false);
    expect(isReadOnlyCommand('cat <<EOF\nfoo\nEOF')).toBe(false);
  });

  it('judges launchers by subcommand instead of blacklisting the whole tool', () => {
    // 只读子命令
    expect(isReadOnlyCommand('systemctl status nginx')).toBe(true);
    expect(isReadOnlyCommand('docker ps -a')).toBe(true);
    expect(isReadOnlyCommand('docker logs web')).toBe(true);
    expect(isReadOnlyCommand('kubectl get pods')).toBe(true);
    expect(isReadOnlyCommand('git status')).toBe(true);
    expect(isReadOnlyCommand('git log --oneline -5')).toBe(true);
    expect(isReadOnlyCommand('npm ls')).toBe(true);
    // 写子命令
    expect(isReadOnlyCommand('systemctl restart nginx')).toBe(false);
    expect(isReadOnlyCommand('docker rm -f web')).toBe(false);
    expect(isReadOnlyCommand('kubectl delete pod x')).toBe(false);
    expect(isReadOnlyCommand('git push origin main')).toBe(false);
    expect(isReadOnlyCommand('npm install')).toBe(false);
    // 未知子命令一律按写处理
    expect(isReadOnlyCommand('systemctl daemon-reexec')).toBe(false);
  });

  it('treats a chained command as a write when any segment writes', () => {
    expect(isReadOnlyCommand('df -h && rm -rf /tmp/x')).toBe(false);
    expect(isReadOnlyCommand('ls | grep foo || mkdir /tmp/x')).toBe(false);
  });
});

describe('Execution decision policy', () => {
  it('observe mode rejects writes and allows reads', () => {
    expect(decideExecution('observe', 'rm -rf /tmp/x', false)).toMatchObject({ action: 'reject' });
    expect(decideExecution('observe', 'df -h', false)).toMatchObject({ action: 'allow' });
  });

  it('confirm mode asks before writes even when the guard list does not fire', () => {
    expect(decideExecution('confirm', 'mkdir /tmp/x', false)).toMatchObject({ action: 'confirm' });
    expect(decideExecution('confirm', 'df -h', false)).toMatchObject({ action: 'allow' });
    expect(decideExecution('confirm', 'reboot', true)).toMatchObject({ action: 'confirm' });
  });

  it('auto mode skips confirmation but never upgrades to rejection by itself', () => {
    expect(decideExecution('auto', 'rm -rf /tmp/x', true)).toMatchObject({ action: 'allow' });
    expect(decideExecution('auto', 'df -h', true)).toMatchObject({ action: 'allow' });
  });

  it('observe wins over everything, including auto-style guard results', () => {
    expect(decideExecution('observe', 'systemctl restart nginx', true)).toMatchObject({ action: 'reject' });
  });
});
