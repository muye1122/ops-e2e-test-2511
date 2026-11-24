import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';

const OPS = 'http://127.0.0.1:3001/api/v1';
const GATEWAY = 'http://127.0.0.1:3002/api/v1';
const REVIEW = 'http://127.0.0.1:3003/api/v1';
const VENDOR = 'http://127.0.0.1:3004/api/v1';
const LOG_PATH = path.join(process.cwd(), 'mock-vendor-requests.log');

// Fully fictional contact details created only for this test suite.
const PHONE = '13800001234';
const EMAIL = 'lianxi@example.test';
const PRIVATE_MARKER = '内部谈判底线';
const MINUTES = [
  '【会议纪要】季度会员服务复盘（虚构）',
  '时间：2026-11-20（虚构）',
  `联系手机：${PHONE}`,
  `联系邮箱：${EMAIL}`,
  `【非公开】本段涉及未披露的${PRIVATE_MARKER}与虚构报价，禁止进入模型请求。`,
  '公开结论：下季度增加两场会员活动。',
  '行动项：运营助理整理总结并生成回顾草稿。',
].join('\n');

async function resetAll(request) {
  for (const base of [VENDOR, GATEWAY, REVIEW, OPS]) {
    const r = await request.post(`${base}/reset`, { data: {} });
    expect(r.ok(), `reset ${base}`).toBeTruthy();
  }
}

async function generateSummary(request) {
  const res = await request.post(`${OPS}/meeting-minutes/upload`, {
    data: { title: '会后总结（虚构）', drafter: 'editor-01', minutes: MINUTES },
  });
  expect(res.status()).toBe(201);
  return res.json();
}

async function runAllFlows(request) {
  const plan = await request.post(`${OPS}/activity-plans/generate`, {
    data: { title: '春季会员交流会方案（虚构）', drafter: 'editor-01' },
  });
  expect(plan.status()).toBe(201);
  const planId = (await plan.json()).draft.id;
  const confirm = await request.post(`${OPS}/activity-plans/${planId}/confirm`, {
    data: { actor: 'employee-01' },
  });
  expect(confirm.status()).toBe(200);

  for (const channel of ['wechat', 'sms', 'email', 'in_app']) {
    const gen = await request.post(`${OPS}/channel-copies/generate`, {
      data: { channel, drafter: 'editor-01' },
    });
    expect(gen.status()).toBe(201);
    const id = (await gen.json()).draft.id;
    const approve = await request.post(`${OPS}/channel-copies/${id}/approve`, {
      data: { actor: 'supervisor-01' },
    });
    expect(approve.status()).toBe(200);
  }

  const uploaded = await generateSummary(request);
  const summaryId = uploaded.draft.id;
  const approve = await request.post(`${OPS}/meeting-minutes/${summaryId}/approve`, {
    data: { actor: 'editor-01' },
  });
  expect(approve.status()).toBe(200);
  const retro = await request.post(`${OPS}/meeting-minutes/${summaryId}/retro`, {
    data: { drafter: 'editor-01' },
  });
  expect(retro.status()).toBe(201);
  return { planId, summaryId, retroId: (await retro.json()).draft.id };
}

// =====================================================================
// Group 1 - activity plan: generate -> pending_review -> employee confirm
//           -> effective -> Word export 200
// =====================================================================
test('G1 活动方案：生成→待复核→员工确认→生效→导出 Word 返回 200', async ({ request }) => {
  await resetAll(request);

  const gen = await request.post(`${OPS}/activity-plans/generate`, {
    data: { title: '春季会员交流会方案（虚构）', drafter: 'editor-01' },
  });
  expect(gen.status()).toBe(201);
  const draft = (await gen.json()).draft;
  expect(draft.kind).toBe('activity_plan');
  expect(draft.status).toBe('pending_review');
  expect(draft.level).toBe('L2');
  expect(draft.drafter).toBe('editor-01');

  const confirm = await request.post(`${OPS}/activity-plans/${draft.id}/confirm`, {
    data: { actor: 'employee-01' },
  });
  expect(confirm.status()).toBe(200);
  const effective = (await confirm.json()).draft;
  expect(effective.status).toBe('effective');
  expect(effective.approver).toBe('employee-01');
  expect(effective.history.map((h) => h.action)).toEqual(['create', 'confirm']);

  const exportRes = await request.post(`${OPS}/activity-plans/${draft.id}/export`, { data: {} });
  expect(exportRes.status()).toBe(200);
  expect(exportRes.headers()['content-type']).toContain('msword');
  const bytes = await exportRes.body();
  expect(bytes.length).toBeGreaterThan(100);
  expect(bytes.toString('utf8')).toContain('春季会员交流会方案（虚构）');
});

// =====================================================================
// Group 2 - four channel copies: all L2, self approval forbidden,
//           supervisor approval makes every one effective
// =====================================================================
test('G2 四渠道文案：全 L2、起草人自审被拒、主管审批后生效', async ({ request }) => {
  await resetAll(request);

  const meta = await (await request.get(`${OPS}/channel-copies/channels`)).json();
  expect(meta.channels).toEqual(['wechat', 'sms', 'email', 'in_app']);
  expect(meta.level).toBe('L2');

  const ids = [];
  for (const channel of meta.channels) {
    const gen = await request.post(`${OPS}/channel-copies/generate`, {
      data: { channel, drafter: 'editor-01' },
    });
    expect(gen.status()).toBe(201);
    const draft = (await gen.json()).draft;
    expect(draft.channel).toBe(channel);
    expect(draft.level).toBe('L2');
    expect(draft.status).toBe('pending_review');
    ids.push(draft.id);
  }

  for (const id of ids) {
    const self = await request.post(`${OPS}/channel-copies/${id}/approve`, {
      data: { actor: 'editor-01' },
    });
    expect(self.status()).toBe(403);
    expect(await self.json()).toMatchObject({ code: 'SELF_APPROVAL_FORBIDDEN', draft_id: id });
  }

  for (const id of ids) {
    const ok = await request.post(`${OPS}/channel-copies/${id}/approve`, {
      data: { actor: 'supervisor-01' },
    });
    expect(ok.status()).toBe(200);
    expect((await ok.json()).draft.status).toBe('effective');
  }

  const queue = await (await request.get(`${REVIEW}/drafts`)).json();
  const copies = queue.drafts.filter((d) => d.kind === 'channel_copy');
  expect(copies.length).toBe(4);
  for (const d of copies) {
    expect(d.level).toBe('L2');
    expect(d.status).toBe('effective');
    expect(d.approver).toBe('supervisor-01');
  }
});

// =====================================================================
// Group 3 - meeting summary: segmented summarization, L1 effective,
//           L2 retro draft, redaction and restoration
// =====================================================================
test('G3 会后总结：分段汇总→L1 生效→生成 L2 回顾草稿', async ({ request }) => {
  await resetAll(request);

  const uploaded = await generateSummary(request);
  const summary = uploaded.draft;
  expect(summary.level).toBe('L1');
  expect(summary.status).toBe('pending_review');
  expect(uploaded.redaction.segment_count).toBeGreaterThanOrEqual(5);
  expect(uploaded.redaction.placeholders).toEqual(
    expect.arrayContaining(['[PHONE_1]', '[EMAIL_1]', '[PRIVATE_1]']),
  );
  expect(summary.redacted_body).not.toContain(PHONE);
  expect(summary.redacted_body).not.toContain(EMAIL);
  expect(summary.redacted_body).not.toContain(PRIVATE_MARKER);

  const approve = await request.post(`${OPS}/meeting-minutes/${summary.id}/approve`, {
    data: { actor: 'editor-01' },
  });
  expect(approve.status()).toBe(200);
  expect((await approve.json()).draft.status).toBe('effective');

  const retro = await request.post(`${OPS}/meeting-minutes/${summary.id}/retro`, {
    data: { drafter: 'editor-01' },
  });
  expect(retro.status()).toBe(201);
  const draft = (await retro.json()).draft;
  expect(draft.kind).toBe('retro_draft');
  expect(draft.level).toBe('L2');
  expect(draft.status).toBe('pending_review');
  expect(draft.redacted_body).not.toContain(PHONE);
  expect(draft.redacted_body).not.toContain(EMAIL);

  const vendorRequests = await (await request.get(`${VENDOR}/requests`)).json();
  expect(vendorRequests.total).toBeGreaterThanOrEqual(9);
});

test('G3 脱敏断言：mock 供应商请求日志文件无原始手机号、邮箱与非公开段落', async ({ request }) => {
  await resetAll(request);
  const uploaded = await generateSummary(request);
  const id = uploaded.draft.id;
  await request.post(`${OPS}/meeting-minutes/${id}/approve`, { data: { actor: 'editor-01' } });
  const retro = await request.post(`${OPS}/meeting-minutes/${id}/retro`, { data: { drafter: 'editor-01' } });
  expect(retro.status()).toBe(201);

  expect(fs.existsSync(LOG_PATH)).toBe(true);
  const raw = fs.readFileSync(LOG_PATH, 'utf8');
  expect(raw.trim().length).toBeGreaterThan(0);
  const lines = raw.trim().split(/\r?\n/).map((line) => JSON.parse(line));
  expect(lines.length).toBeGreaterThanOrEqual(9);

  const dump = JSON.stringify(lines);
  expect(dump).not.toContain(PHONE);
  expect(dump).not.toContain(EMAIL);
  expect(dump).not.toContain(PRIVATE_MARKER);
  expect(dump).not.toContain('【非公开】');
  // A second, independent read through the service API.
  const apiDump = JSON.stringify((await (await request.get(`${VENDOR}/requests`)).json()).requests);
  expect(apiDump).not.toContain(PHONE);
  expect(apiDump).not.toContain(EMAIL);
  expect(apiDump).not.toContain(PRIVATE_MARKER);
});

test('G3 还原断言：草稿中手机号与邮箱被还原，非公开段落不出现', async ({ request }) => {
  await resetAll(request);
  const uploaded = await generateSummary(request);
  const id = uploaded.draft.id;
  const summary = uploaded.draft;
  expect(summary.body).toContain(PHONE);
  expect(summary.body).toContain(EMAIL);
  expect(summary.body).not.toContain(PRIVATE_MARKER);

  await request.post(`${OPS}/meeting-minutes/${id}/approve`, { data: { actor: 'editor-01' } });
  const retro = await request.post(`${OPS}/meeting-minutes/${id}/retro`, { data: { drafter: 'editor-01' } });
  const draft = (await retro.json()).draft;
  expect(draft.body).toContain(PHONE);
  expect(draft.body).toContain(EMAIL);
  expect(draft.body).not.toContain(PRIVATE_MARKER);
  expect(draft.body).not.toContain('【非公开】');
});

// =====================================================================
// Group 4 - zero outbound: aggregated audit across all four services
// =====================================================================
test('G4 零外发：运营辅助服务只访问网关与复核队列', async ({ request }) => {
  await resetAll(request);
  await runAllFlows(request);

  const ops = await (await request.get(`${OPS}/audit/outbound`)).json();
  expect(ops.service).toBe('operations-assistant');
  expect(ops.outbound.length).toBeGreaterThan(0);
  expect(ops.targets).toEqual(['model-gateway', 'review-queue']);
  expect(ops.allowed_targets).toEqual(['model-gateway', 'review-queue']);
  for (const rec of ops.outbound) {
    expect(['model-gateway', 'review-queue']).toContain(rec.target);
  }
  const gateway = await (await request.get(`${GATEWAY}/audit/outbound`)).json();
  expect(gateway.outbound.length).toBeGreaterThan(0);
  for (const rec of gateway.outbound) expect(rec.target).toBe('mock-vendor');
});

test('G4 白名单与 send 类调用：所有容器拦截日志为空且无外发 API', async ({ request }) => {
  await resetAll(request);
  await runAllFlows(request);

  for (const base of [OPS, GATEWAY, REVIEW, VENDOR]) {
    const audit = await (await request.get(`${base}/audit/outbound`)).json();
    expect(audit.blocked, `${base} blocked`).toEqual([]);
    expect(audit.send_calls, `${base} send_calls`).toEqual([]);
  }

  // Pure evaluation proves the guard works without creating an outbound attempt.
  const external = await request.post(`${OPS}/outbound/evaluate`, {
    data: { url: 'https://outside.example.test/send_message' },
  });
  expect(external.status()).toBe(200);
  const verdict = await external.json();
  expect(verdict.allowed).toBe(false);
  expect(verdict.is_send_api).toBe(true);
  expect(verdict.reason).toBe('OUTBOUND_NOT_ALLOWED');

  const allowed = await request.post(`${OPS}/outbound/evaluate`, {
    data: { url: `${REVIEW}/drafts` },
  });
  expect((await allowed.json()).allowed).toBe(true);

  // The evaluation itself must not pollute the real audit logs.
  for (const base of [OPS, GATEWAY, REVIEW, VENDOR]) {
    const audit = await (await request.get(`${base}/audit/outbound`)).json();
    expect(audit.blocked).toEqual([]);
    expect(audit.send_calls).toEqual([]);
  }
});

// =====================================================================
// Demo UI smoke check (the acceptance matrix above is API-level)
// =====================================================================
test('演示界面：展示复核状态与零外发计数', async ({ page, request }) => {
  await resetAll(request);
  await page.goto('/');
  await expect(page.getByTestId('demo-banner')).toBeVisible();
  await expect(page.getByTestId('outbound-count')).toHaveText('0');
  await page.getByTestId('demo-run-btn').click();
  await expect(page.getByTestId('demo-msg')).toContainText('演示完成');
  await expect(page.getByTestId('channel-count')).toHaveText('4');
  await expect(page.getByTestId('effective-count')).toHaveText('5');
  await expect(page.getByTestId('outbound-count')).toHaveText('0');
  await expect(page.getByTestId('blocked-count')).toHaveText('0');
  await expect(page.getByTestId('records-table')).toContainText('channel_copy');
});
