import { expect, test, type Page } from './fixtures';
import { mockAnonymousSession } from './helpers';

/** 面板打开时会把服务端保存的对话拉回来；接口按方法显式 Mock。 */
async function routeConversation(page: Page, transcript: Record<string, unknown>) {
  // 带 ?thread= 的读取同样要命中：用正则匹配路径前缀。
  await page.route(/\/api\/servers\/1\/conversation(\?.*)?$/, async route => {
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
    thread_id: 'thread00000001',
    title: '磁盘排查',
    title_custom: false,
    created_at: 1,
    updated_at: 3,
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

test('「新对话」开一条新线程，旧对话仍留在会话历史里', async ({ page }) => {
  await mockAnonymousSession(page);
  await page.route('**/api/servers/1/memory', route => route.fulfill({ json: { workLogs: [], knowledge: [] } }));
  await page.route('**/api/servers/1/conversations', async route => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: { threads: [
        { thread_id: 'thread00000001', title: '旧话题内容', title_custom: false,
          message_count: 1, preview: '旧回复', created_at: 1, updated_at: 2 },
      ], active_thread_id: 'thread00000001' } });
      return;
    }
    await route.fulfill({ json: { success: true } });
  });
  await routeConversation(page, {
    thread_id: 'thread00000001',
    title: '旧话题内容',
    title_custom: false,
    created_at: 1,
    updated_at: 2,
    revision: 3,
    messages: [{ seq: 1, role: 'user', content: '旧话题内容', created_at: 1 }],
  });
  const hydration = page.waitForResponse(response =>
    response.url().endsWith('/api/servers/1/conversation') && response.request().method() === 'GET',
  ).catch(() => null);
  await mountPanel(page);
  await hydration;
  await expect(page.locator('#agent-messages .agent-message')).toHaveCount(1);

  // 新对话只发送 agent_reset（服务端开新线程），不再发 DELETE 清空历史。
  let deleted = false;
  page.on('request', request => {
    if (request.method() === 'DELETE' && request.url().endsWith('/api/servers/1/conversation')) deleted = true;
  });
  await page.evaluate(() => {
    const { panel } = (window as any).__conversation;
    panel.handleAgentFrame({ subType: 'reset_done' });
    panel['resetPanelState']();
  });
  const outbound = await page.evaluate(() => (window as any).__conversation.sent.map((frame: any) => frame.type));
  expect(outbound).not.toContain('agent_thread_delete');
  expect(deleted).toBe(false);
});

test('会话历史抽屉列出线程并可打开其中一条', async ({ page }) => {
  await mockAnonymousSession(page);
  await page.route('**/api/servers/1/memory', route => route.fulfill({ json: { workLogs: [], knowledge: [] } }));
  await page.route('**/api/servers/1/conversations', async route => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: { threads: [
        { thread_id: 'thread00000001', title: '磁盘排查', title_custom: false, message_count: 2,
          preview: '根分区 92%', created_at: 1, updated_at: 3 },
        { thread_id: 'thread00000002', title: '部署 Nginx', title_custom: true, message_count: 4,
          preview: '服务已启动', created_at: 2, updated_at: 4 },
      ], active_thread_id: 'thread00000002' } });
      return;
    }
    await route.fulfill({ json: { success: true } });
  });
  await routeConversation(page, {
    thread_id: 'thread00000002', title: '部署 Nginx', title_custom: true,
    created_at: 2, updated_at: 4, revision: 5, messages: [],
  });
  const hydration = page.waitForResponse(response =>
    response.url().endsWith('/api/servers/1/conversation') && response.request().method() === 'GET',
  ).catch(() => null);
  await mountPanel(page);
  await hydration;

  await page.locator('#agent-threads-btn').click();
  const rows = page.locator('#agent-threads-content .agent-thread-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('磁盘排查');
  await expect(rows.nth(1)).toContainText('部署 Nginx');

  await rows.nth(0).click();
  const outbound = await page.evaluate(() => (window as any).__conversation.sent
    .filter((frame: any) => frame.type === 'agent_thread_open').map((frame: any) => frame.threadId));
  expect(outbound).toEqual(['thread00000001']);
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
