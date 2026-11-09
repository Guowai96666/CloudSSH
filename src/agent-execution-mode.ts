/**
 * Agent 执行模式（三档，前后端共享）
 *
 * 由输入框旁的下拉框选择，随每次 `agent_start` 下发，服务端在工具层强制执行：
 *
 * - `observe`：只读。任何会改动服务器状态的命令直接拒绝，不执行、不询问。
 * - `confirm`：写操作前确认。只读命令直接执行；写操作必须先经用户批准。
 * - `auto`：自动执行。连写操作也不再打断，但 `safety.ts` 的硬拦截（rm -rf /、mkfs 等）仍然生效。
 */

export const AGENT_EXECUTION_MODES = ['auto', 'confirm', 'observe'] as const;

export type AgentExecutionMode = (typeof AGENT_EXECUTION_MODES)[number];

/** 默认模式：写操作前确认，与历史行为一致但语义更明确。 */
export const DEFAULT_AGENT_EXECUTION_MODE: AgentExecutionMode = 'confirm';

/**
 * 校验并规范化客户端下发的模式。
 * @param value 原始值（可能来自旧版本客户端，或是任意字符串）。
 * @returns 合法模式；无法识别时回落到默认值，绝不因缺省字段而放宽权限。
 */
export function normalizeAgentExecutionMode(value: unknown): AgentExecutionMode {
  return typeof value === 'string' && (AGENT_EXECUTION_MODES as readonly string[]).includes(value)
    ? value as AgentExecutionMode
    : DEFAULT_AGENT_EXECUTION_MODE;
}

/** 只读命令前缀：这些命令在任何模式下都直接执行，不会被观察模式拒绝。 */
const READ_ONLY_COMMANDS = new Set([
  'ls', 'cat', 'head', 'tail', 'less', 'more', 'stat', 'file', 'wc', 'du', 'df',
  'free', 'uptime', 'whoami', 'id', 'pwd', 'uname', 'hostname', 'date', 'env', 'printenv',
  'ps', 'top', 'htop', 'ss', 'netstat', 'ip', 'ifconfig', 'route', 'ping', 'dig', 'nslookup',
  'grep', 'egrep', 'fgrep', 'rg', 'awk', 'cut', 'sort', 'uniq', 'tr', 'sed',
  'find', 'locate', 'which', 'whereis', 'type', 'lsblk', 'lscpu', 'lsmod', 'lspci', 'lsusb',
  'journalctl', 'dmesg', 'last', 'w', 'who', 'history', 'tar', 'unzip',
]);

/**
 * 子命令决定读写身份的启动器：只有白名单里的子命令算只读，
 * 其余（restart / rm / push / install …）一律按写处理。
 */
const SUBCOMMAND_POLICY: Record<string, { readOnly: Set<string>; known: Set<string> }> = {
  systemctl: {
    readOnly: new Set(['status', 'show', 'list-units', 'list-unit-files', 'is-active', 'is-enabled', 'cat']),
    known: new Set(['status', 'show', 'list-units', 'list-unit-files', 'is-active', 'is-enabled', 'cat',
      'start', 'stop', 'restart', 'reload', 'enable', 'disable', 'mask', 'unmask', 'daemon-reload']),
  },
  service: {
    readOnly: new Set(['status']),
    known: new Set(['status', 'start', 'stop', 'restart', 'reload']),
  },
  docker: {
    readOnly: new Set(['ps', 'logs', 'inspect', 'images', 'stats', 'version', 'info', 'top']),
    known: new Set(['ps', 'logs', 'inspect', 'images', 'stats', 'version', 'info', 'top',
      'run', 'rm', 'rmi', 'stop', 'start', 'restart', 'kill', 'exec', 'build', 'push', 'pull', 'compose']),
  },
  podman: {
    readOnly: new Set(['ps', 'logs', 'inspect', 'images', 'stats', 'version', 'info']),
    known: new Set(['ps', 'logs', 'inspect', 'images', 'stats', 'version', 'info',
      'run', 'rm', 'rmi', 'stop', 'start', 'restart', 'kill', 'exec', 'build', 'push', 'pull']),
  },
  kubectl: {
    readOnly: new Set(['get', 'describe', 'logs', 'top', 'version', 'explain', 'api-resources']),
    known: new Set(['get', 'describe', 'logs', 'top', 'version', 'explain', 'api-resources',
      'apply', 'delete', 'create', 'edit', 'patch', 'scale', 'rollout', 'exec', 'drain', 'cordon']),
  },
  git: {
    readOnly: new Set(['status', 'log', 'diff', 'show', 'branch', 'remote', 'config', 'ls-files', 'rev-parse', 'blame']),
    known: new Set(['status', 'log', 'diff', 'show', 'branch', 'remote', 'config', 'ls-files', 'rev-parse',
      'blame', 'push', 'pull', 'fetch', 'commit', 'merge', 'rebase', 'reset', 'checkout', 'clean', 'add']),
  },
  npm: {
    readOnly: new Set(['list', 'ls', 'view', 'outdated', 'config', 'root', 'prefix']),
    known: new Set(['list', 'ls', 'view', 'outdated', 'config', 'root', 'prefix',
      'install', 'i', 'add', 'remove', 'uninstall', 'update', 'run', 'start', 'test', 'publish']),
  },
};

/** 明显会写文件/改状态的子命令或参数：只读命令配上它们就变成写操作。 */
const WRITE_FLAGS = [
  /\s(?:-i|--in-place)\b/, /\s(?:-o|--output)(?:\s|=)/, /\s>>?\s*\S/, /\s--delete\b/, /\s-exec\s+(?:rm|mv|cp|shred)\b/,
  /\b(?:install|remove|uninstall|purge|update|upgrade|start|stop|restart|reload|enable|disable|set|create|delete|drop|truncate|flush|restore|apply|patch|run|exec|kill|restart|scale|edit|write|touch|mkdir|rmdir|mv|cp|ln|chmod|chown|chattr|truncate|tee|dd)\b/,
];

/** 只读命令里本身就会写文件的子命令（mysql/psql 等交互工具按写处理）。 */
const WRITE_COMMAND_NAMES = new Set([
  'mysql', 'psql', 'redis-cli', 'mongo', 'mongosh', 'sqlite3', 'tee', 'cp', 'mv', 'ln', 'rm', 'rmdir',
  'mkdir', 'touch', 'chmod', 'chown', 'chgrp', 'chattr', 'truncate', 'dd', 'mkfs', 'mount', 'umount',
  'apt', 'apt-get', 'yum', 'dnf', 'apk', 'pacman', 'pip', 'pip3', 'yarn', 'pnpm', 'gem',
  'kill', 'pkill', 'killall', 'reboot', 'shutdown', 'halt', 'poweroff',
  'useradd', 'userdel', 'usermod', 'groupadd', 'passwd', 'visudo', 'crontab', 'iptables', 'nft', 'ufw',
]);

/** 把一段命令切成 [命令名, 子命令...] 的形式（已跳过 sudo/env 等前缀）。 */
function commandTokens(segment: string): string[] {
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  let index = 0;
  while (index < tokens.length && /^(?:sudo|doas|env|command|exec|nohup|time|nice|ionice)$/.test(tokens[index])) {
    index++;
    while (index < tokens.length && (tokens[index].startsWith('-') || tokens[index].includes('='))) index++;
  }
  // 跳过形如 VAR=x 的环境变量前缀
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index])) index++;
  if (index >= tokens.length) return [];
  const raw = tokens[index];
  const name = raw.split('/').pop() ?? raw;
  // 子命令：下一个不以 - 开头的词
  let sub: string | undefined;
  for (let next = index + 1; next < tokens.length; next++) {
    if (tokens[next].startsWith('-')) continue;
    sub = tokens[next].split('/').pop();
    break;
  }
  return sub ? [name, sub] : [name];
}

/** 把一条命令拆成可判定的命令名（处理 sudo/env/绝对路径与管道、&&、; 分隔）。 */
function commandNames(command: string): string[] {
  const names: string[] = [];
  // 粗略按 shell 分隔符切开；不做完整解析，只用于模式判定。
  const segments = command.split(/\|\||&&|[|;\n]/);
  for (const segment of segments) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    let index = 0;
    // 跳过 sudo/env/command/exec/nohup 及其参数
    while (index < tokens.length && /^(?:sudo|doas|env|command|exec|nohup|time|nice|ionice)$/.test(tokens[index])) {
      index++;
      while (index < tokens.length && (tokens[index].startsWith('-') || tokens[index].includes('='))) index++;
    }
    if (index >= tokens.length) continue;
    const raw = tokens[index];
    names.push(raw.split('/').pop() ?? raw);
    // 处理 `VAR=x cmd` 形式
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(raw) && tokens[index + 1]) {
      const next = tokens[index + 1].split('/').pop();
      if (next) names.push(next);
    }
  }
  return names;
}

/**
 * 判断一条命令是否只是读取数据。
 *
 * 判定保守：只有「第一段命令是已知只读工具」「没有写重定向」「没有明显写操作参数」
 * 时才判为只读，其余一律视为写操作，避免观察模式被拼凑命令绕过。
 *
 * @param command 待判定的命令文本。
 * @returns true 表示可以安全执行而不改变服务器状态。
 */
export function isReadOnlyCommand(command: string): boolean {
  const text = command.trim();
  if (!text) return true;
  // 命令替换与 heredoc 一律按写处理：无法静态确定副作用。
  if (/\$\(|`|\beval\b|<<-?\s*\w/.test(text)) return false;
  // 重定向写文件
  if (/(^|[^&\d>])>\s*[^>&]/.test(text) || />>/.test(text)) return false;

  const names = commandNames(text);
  if (names.length === 0) return false;
  for (const name of names) {
    if (WRITE_COMMAND_NAMES.has(name)) return false;
    const policy = SUBCOMMAND_POLICY[name];
    if (policy) continue; // 由下方子命令判定
    if (!READ_ONLY_COMMANDS.has(name)) return false;
  }
  // 子命令策略：只有白名单子命令算只读，未知子命令一律按写处理。
  for (const segment of text.split(/\|\||&&|[|;\n]/)) {
    const tokens = commandTokens(segment);
    if (tokens.length === 0) continue;
    const [name, sub] = tokens;
    const policy = SUBCOMMAND_POLICY[name];
    if (!policy) continue;
    if (!sub || !policy.readOnly.has(sub)) return false;
  }
  // 只读命令 + 写参数/写子命令也按写处理
  return !WRITE_FLAGS.some(pattern => pattern.test(text));
}

/**
 * 判定某条命令在给定模式下应当如何处理。
 * @param mode 当前执行模式。
 * @param command 待执行的命令。
 * @param guardsRequireConfirmation `safety.needsConfirmation` 的结论（硬拦截仍优先）。
 * @returns 执行裁决：允许 / 需确认 / 拒绝。
 */
export function decideExecution(
  mode: AgentExecutionMode,
  command: string,
  guardsRequireConfirmation: boolean
): { action: 'allow' | 'confirm' | 'reject'; reason?: string } {
  if (mode === 'observe' && !isReadOnlyCommand(command)) {
    return { action: 'reject', reason: '观察模式：只允许只读命令' };
  }
  if (mode === 'auto') {
    // 自动模式仍保留 safety.ts 的硬拦截；确认类提示不再打断。
    return { action: 'allow' };
  }
  if (guardsRequireConfirmation) return { action: 'confirm' };
  // 确认模式：写操作必须确认，即使不在高危清单里。
  if (mode === 'confirm' && !isReadOnlyCommand(command)) {
    return { action: 'confirm', reason: '写操作需要确认' };
  }
  return { action: 'allow' };
}
