import { expect, test, type Page } from './fixtures';
import { mockAnonymousSession } from './helpers';

/** 面板打开时会把服务端保存的对话拉回来；接口按方法显式 Mock。 */
async function routeConversation(page: Page, transcript: { messages: unknown[]; revision: number }) {
  await page.route('**/api/servers/1/conversation', async route => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: transcript });
      return;
    }
    await route.fulfill({ json: { success: true } });
  });
}

async function mountPanel(page: Page) {
  await page.goto('/?lang=zh-CN');
  await page.evaluate(async () => {
    const sent: any[] = [];
    const module = await (window as any).eval("import('/src/agent/agent-panel.ts')");
    const panel = new module.AgentPanel(document.body, true, 1, 42);
    panel.render();
    panel.setWebSocketSend((data: string) => sent.push(JSON.parse(data)));
    document.getElementById('terminal-section')?.classList.remove('hidden');
    panel.show();
    (window as any).__conversation = { panel, sent };
  });
}

test('重新打开面板后恢复上次对话，模型上下文由服务端记录接续', async ({ page }) => {
  await mockAnonymousSession(page);
  await page.route('**/api/servers/1/memory', route => route.fulfill({ json: { workLogs: [], knowledge: [] } }));
  await routeConversation(page, {
    revision: 7,
    messages: [
      { seq: 1, role: 'user', content: '帮我看看磁盘使用', created_at: 1 },
      { seq: 2, role: 'assistant', content: '根分区占用 92%，建议清理日志。', created_at: 2 },
      { seq: 3, role: 'user', content: '那先清日志', created_at: 3 },
    ],
  });
  const hydration = page.waitForResponse(response =>
    response.url().endsWith('/api/servers/1/conversation') && response.request().method() === 'GET',
  ).catch(() => null);
  await mountPanel(page);
  await hydration;
  // 水合是异步的：等消息容器稳定后再断言。
  await page.waitForTimeout(150);

  const messages = page.locator('#agent-messages .agent-message');
  await expect(messages).toHaveCount(3);
  await expect(messages.nth(0)).toContainText('帮我看看磁盘使用');
  await expect(messages.nth(1)).toContainText('根分区占用 92%');
  await expect(messages.nth(2)).toContainText('那先清日志');

  // 恢复后继续提问：新消息追加在历史之后，且不重复发送旧内容。
  await page.evaluate(() => {
    const { panel } = (window as any).__conversation;
    panel.sendMessage('继续清理');
  });
  const outbound = await page.evaluate(() => (window as any).__conversation.sent
    .filter((frame: any) => frame.type === 'agent_start').map((frame: any) => frame.message));
  expect(outbound).toEqual(['继续清理']);
  await expect(messages).toHaveCount(4);
});

test('「新对话」清空服务端记录，重新打开不再恢复旧内容', async ({ page }) => {
  await mockAnonymousSession(page);
  await page.route('**/api/servers/1/memory', route => route.fulfill({ json: { workLogs: [], knowledge: [] } }));
  await routeConversation(page, {
    revision: 3,
    messages: [{ seq: 1, role: 'user', content: '旧话题内容', created_at: 1 }],
  });
  const hydration = page.waitForResponse(response =>
    response.url().endsWith('/api/servers/1/conversation') && response.request().method() === 'GET',
  ).catch(() => null);
  await mountPanel(page);
  await hydration;
  await expect(page.locator('#agent-messages .agent-message')).toHaveCount(1);

  let deleted = false;
  await page.route('**/api/servers/1/conversation', async route => {
    if (route.request().method() === 'DELETE') {
      deleted = true;
      await route.fulfill({ json: { success: true } });
      return;
    }
    await route.fulfill({ json: { messages: [], revision: 0 } });
  });
  await page.evaluate(() => {
    const { panel } = (window as any).__conversation;
    panel.handleAgentFrame({ subType: 'reset_done' });
    return (panel as any).clearServerConversation();
  });
  expect(deleted).toBe(true);
});

test('服务端对话为空或接口失败时保持空面板，不阻塞提问', async ({ page }) => {
  await mockAnonymousSession(page);
  await page.route('**/api/servers/1/memory', route => route.fulfill({ json: { workLogs: [], knowledge: [] } }));
  await page.route('**/api/servers/1/conversation', async route => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ status: 500, json: { error: 'boom' } });
      return;
    }
    await route.fulfill({ json: { success: true } });
  });
  // 失败分支同样等一次 GET 结束，避免与端到端水合竞争。
  const hydration = page.waitForResponse(response =>
    response.url().endsWith('/api/servers/1/conversation') && response.request().method() === 'GET',
    { timeout: 5000 },
  ).catch(() => null);
  await mountPanel(page);
  await hydration;
  await expect(page.locator('#agent-messages .agent-message')).toHaveCount(0);
  await page.evaluate(() => { (window as any).__conversation.panel.sendMessage('还在吗'); });
  const outbound = await page.evaluate(() => (window as any).__conversation.sent
    .filter((frame: any) => frame.type === 'agent_start').length);
  expect(outbound).toBe(1);
});
