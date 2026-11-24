/**
 * Operations assistant service (Express simulation).
 *
 * Responsibilities:
 *  - orchestrate the three flows (activity plan / channel copies / meeting summary)
 *  - REDACT phone numbers, e-mail addresses and private paragraphs BEFORE any
 *    gateway call, keeping a reversible map inside this service only
 *  - restore phone/e-mail placeholders in the draft stored by the review queue
 *  - route every outbound request through a strict allowlist: only the model
 *    gateway and the review queue are reachable; send-type APIs are impossible
 *
 * All data is fictional. The in-memory maps stand in for PostgreSQL/Redis.
 */
import express from 'express';

const app = express();
app.use(express.json({ limit: '2mb' }));

const API = '/api/v1';
const PORT = process.env.OPS_PORT || 3001;
const GATEWAY_URL = process.env.GATEWAY_URL || 'http://127.0.0.1:3002';
const REVIEW_URL = process.env.REVIEW_URL || 'http://127.0.0.1:3003';

const ALLOWED_TARGETS = new Set(['model-gateway', 'review-queue']);
let records = new Map();
let outbound = [];
let blocked = [];
const sendCalls = []; // no send-type API is registered anywhere in the topology

// ---------------------------------------------------------------- redaction
const PHONE_RE = /(?<!\d)1[3-9]\d{9}(?!\d)/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

function redact(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const map = {};
  let privateNo = 0;
  let phoneNo = 0;
  let emailNo = 0;

  const redactedLines = lines.map((line) => {
    if (line.includes('【非公开】')) {
      const key = `[PRIVATE_${++privateNo}]`;
      map[key] = line.trim();
      return key;
    }
    let s = line;
    s = s.replace(PHONE_RE, (raw) => {
      const key = `[PHONE_${++phoneNo}]`;
      map[key] = raw;
      return key;
    });
    s = s.replace(EMAIL_RE, (raw) => {
      const key = `[EMAIL_${++emailNo}]`;
      map[key] = raw;
      return key;
    });
    return s;
  });

  return { text: redactedLines.join('\n'), map, placeholders: Object.keys(map) };
}

function restore(text, map, includePrivate = false) {
  let s = String(text ?? '');
  const keys = Object.keys(map).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (!includePrivate && key.startsWith('[PRIVATE_')) continue;
    s = s.split(key).join(map[key]);
  }
  return s;
}

// ------------------------------------------------------------------ gateway
function targetOf(url) {
  try {
    const u = new URL(url);
    if (u.port === '3002' || u.hostname === 'model-gateway') return 'model-gateway';
    if (u.port === '3003' || u.hostname === 'review-queue') return 'review-queue';
    return `unknown:${u.host}`;
  } catch {
    return 'unknown';
  }
}

function isSendApi(url) {
  return /send|notify|webhook|message|email/i.test(String(url));
}

/**
 * Single egress gate. Nothing in this service calls fetch directly.
 * Blocked attempts are recorded but never executed; the acceptance suite
 * asserts that the blocked list stays empty in a normal full run.
 */
async function egress(target, url, options, purpose) {
  if (!ALLOWED_TARGETS.has(target) || isSendApi(url)) {
    blocked.push({ ts: new Date().toISOString(), target, url, purpose, reason: 'OUTBOUND_NOT_ALLOWED' });
    const err = new Error('OUTBOUND_NOT_ALLOWED');
    err.code = 'OUTBOUND_NOT_ALLOWED';
    throw err;
  }
  const rec = {
    ts: new Date().toISOString(), target, method: options?.method || 'GET',
    url, purpose, status: null,
  };
  outbound.push(rec);
  const res = await fetch(url, {
    method: options?.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(options?.headers || {}) },
    body: options?.body ? JSON.stringify(options.body) : undefined,
  });
  rec.status = res.status;
  return res;
}

async function infer(body) {
  const res = await egress('model-gateway', `${GATEWAY_URL}${API}/infer`, {
    method: 'POST', body,
  }, 'model_inference');
  if (!res.ok) throw new Error(`GATEWAY_ERROR_${res.status}`);
  return res.json();
}

async function createDraft(draft) {
  const res = await egress('review-queue', `${REVIEW_URL}${API}/drafts`, {
    method: 'POST', body: draft,
  }, 'draft_write');
  if (!res.ok) throw new Error(`REVIEW_QUEUE_ERROR_${res.status}`);
  return (await res.json()).draft;
}

async function readDraft(id) {
  const res = await egress('review-queue', `${REVIEW_URL}${API}/drafts/${id}`, {}, 'draft_read');
  if (!res.ok) throw new Error(`DRAFT_NOT_FOUND_${res.status}`);
  return (await res.json()).draft;
}

async function transition(id, action, actor) {
  const res = await egress('review-queue', `${REVIEW_URL}${API}/drafts/${id}/${action}`, {
    method: 'POST', body: { actor },
  }, 'review_transition');
  const payload = await res.json();
  return { status: res.status, payload, draft: payload.draft || null };
}

function remember(kind, draft, extra = {}) {
  records.set(draft.id, { kind, ...extra, draft });
  return draft;
}

function refresh(id, draft) {
  const rec = records.get(id);
  if (rec && draft) rec.draft = draft;
  return draft;
}

// ------------------------------------------------------------------- routes
app.get(`${API}/health`, (_req, res) => res.json({
  ok: true, service: 'operations-assistant', records: records.size, ts: Date.now(),
}));

/** Pure allowlist evaluation: no request is made and nothing is logged. */
app.post(`${API}/outbound/evaluate`, (req, res) => {
  const url = String(req.body?.url || '');
  const target = targetOf(url);
  const sendApi = isSendApi(url);
  const allowed = ALLOWED_TARGETS.has(target) && !sendApi;
  return res.json({ url, target, is_send_api: sendApi, allowed, reason: allowed ? 'ALLOWED' : 'OUTBOUND_NOT_ALLOWED' });
});

app.get(`${API}/audit/outbound`, (_req, res) => {
  const targets = [...new Set(outbound.map((o) => o.target))].sort();
  return res.json({
    service: 'operations-assistant',
    outbound,
    blocked,
    send_calls: sendCalls,
    targets,
    allowed_targets: [...ALLOWED_TARGETS].sort(),
  });
});

app.get(`${API}/records`, (_req, res) => res.json({
  total: records.size, records: [...records.values()],
}));

// ---- Group 1: activity plan ------------------------------------------------
app.post(`${API}/activity-plans/generate`, async (req, res) => {
  try {
    const title = String(req.body?.title || '虚构会员交流活动');
    const drafter = String(req.body?.drafter || 'editor-01');
    const { text } = await infer({
      task: 'activity_plan',
      prompt: `活动主题：${title}；目标：提升虚构会员参与度；口径：全部虚构。`,
    });
    const draft = await createDraft({
      kind: 'activity_plan', level: 'L2', status: 'pending_review',
      drafter, subject: title, body: text,
      redacted_body: text, placeholders: [],
    });
    return res.status(201).json({ ok: true, draft: remember('activity_plan', draft) });
  } catch (e) {
    return res.status(502).json({ code: 'GENERATION_FAILED', message: e.message });
  }
});

app.post(`${API}/activity-plans/:id/confirm`, async (req, res) => {
  try {
    const actor = String(req.body?.actor || 'employee-01');
    const r = await transition(req.params.id, 'confirm', actor);
    if (r.status !== 200) return res.status(r.status).json(r.payload);
    return res.json({ ok: true, draft: refresh(req.params.id, r.draft) });
  } catch (e) {
    return res.status(502).json({ code: 'TRANSITION_FAILED', message: e.message });
  }
});

app.post(`${API}/activity-plans/:id/export`, async (req, res) => {
  try {
    const draft = await readDraft(req.params.id);
    if (draft.status !== 'effective') {
      return res.status(409).json({ code: 'NOT_EFFECTIVE', message: 'only an effective plan can be exported' });
    }
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const xml = `<?xml version="1.0" encoding="utf-8"?>`
      + `<?mso-application progid="Word.Document"?>`
      + `<w:wordDocument xmlns:w="http://schemas.microsoft.com/office/word/2003/wordml"><w:body>`
      + `<w:p><w:r><w:t>${esc(draft.subject)}</w:t></w:r></w:p>`
      + `<w:p><w:r><w:t>${esc(draft.body)}</w:t></w:r></w:p>`
      + `<w:p><w:r><w:t>状态：${esc(draft.status)}；确认人：${esc(draft.approver)}</w:t></w:r></w:p>`
      + `</w:body></w:wordDocument>`;
    res.setHeader('Content-Type', 'application/msword; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="activity-plan.doc"');
    return res.status(200).send(Buffer.from(xml, 'utf8'));
  } catch (e) {
    return res.status(502).json({ code: 'EXPORT_FAILED', message: e.message });
  }
});

// ---- Group 2: four channel copies -----------------------------------------
const CHANNELS = ['wechat', 'sms', 'email', 'in_app'];

app.get(`${API}/channel-copies/channels`, (_req, res) => res.json({ channels: CHANNELS, level: 'L2' }));

app.post(`${API}/channel-copies/generate`, async (req, res) => {
  try {
    const channel = String(req.body?.channel || '');
    if (!CHANNELS.includes(channel)) {
      return res.status(400).json({ code: 'UNKNOWN_CHANNEL', message: `unknown channel ${channel}` });
    }
    const drafter = String(req.body?.drafter || 'editor-01');
    const { text } = await infer({
      task: 'channel_copy',
      channel,
      prompt: `${channel} 渠道文案：面向虚构会员，介绍虚构权益，口径一致。`,
    });
    const draft = await createDraft({
      kind: 'channel_copy', channel, level: 'L2', status: 'pending_review',
      drafter, subject: `四渠道文案 · ${channel}`, body: text,
      redacted_body: text, placeholders: [],
    });
    return res.status(201).json({ ok: true, draft: remember('channel_copy', draft, { channel }) });
  } catch (e) {
    return res.status(502).json({ code: 'GENERATION_FAILED', message: e.message });
  }
});

app.post(`${API}/channel-copies/:id/approve`, async (req, res) => {
  try {
    const actor = String(req.body?.actor || '');
    const r = await transition(req.params.id, 'approve', actor);
    if (r.status !== 200) return res.status(r.status).json(r.payload);
    return res.json({ ok: true, draft: refresh(req.params.id, r.draft) });
  } catch (e) {
    return res.status(502).json({ code: 'TRANSITION_FAILED', message: e.message });
  }
});

// ---- Group 3: meeting summary ----------------------------------------------
app.post(`${API}/meeting-minutes/upload`, async (req, res) => {
  try {
    const minutes = String(req.body?.minutes || '');
    if (!minutes) return res.status(400).json({ code: 'EMPTY_MINUTES', message: 'minutes required' });
    const drafter = String(req.body?.drafter || 'editor-01');
    const title = String(req.body?.title || '会后总结（虚构）');

    // Redaction happens here, before the FIRST gateway call.
    const red = redact(minutes);
    const segments = red.text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const summaries = [];
    for (let i = 0; i < segments.length; i += 1) {
      const out = await infer({ task: 'summarize_segment', index: i, prompt: segments[i] });
      summaries.push(out.text);
    }
    const merged = await infer({ task: 'merge_summary', prompt: summaries.join(' ') });

    // Restored text stays inside this service and the review queue.
    const restored = restore(merged.text, red.map);
    const draft = await createDraft({
      kind: 'meeting_summary', level: 'L1', status: 'pending_review',
      drafter, subject: title,
      body: restored,
      redacted_body: merged.text,
      placeholders: red.placeholders,
      segment_count: segments.length,
    });
    return res.status(201).json({
      ok: true,
      draft: remember('meeting_summary', draft, { redaction_map: red.map }),
      redaction: { placeholders: red.placeholders, segment_count: segments.length },
    });
  } catch (e) {
    return res.status(502).json({ code: 'SUMMARY_FAILED', message: e.message });
  }
});

app.post(`${API}/meeting-minutes/:id/approve`, async (req, res) => {
  try {
    const actor = String(req.body?.actor || 'editor-01');
    const r = await transition(req.params.id, 'approve', actor);
    if (r.status !== 200) return res.status(r.status).json(r.payload);
    return res.json({ ok: true, draft: refresh(req.params.id, r.draft) });
  } catch (e) {
    return res.status(502).json({ code: 'TRANSITION_FAILED', message: e.message });
  }
});

app.post(`${API}/meeting-minutes/:id/retro`, async (req, res) => {
  try {
    const rec = records.get(req.params.id);
    if (!rec || rec.kind !== 'meeting_summary') {
      return res.status(404).json({ code: 'SUMMARY_NOT_FOUND', message: 'summary not found' });
    }
    const source = await readDraft(req.params.id);
    if (source.status !== 'effective') {
      return res.status(409).json({ code: 'NOT_EFFECTIVE', message: 'summary is not effective yet' });
    }
    const drafter = String(req.body?.drafter || 'editor-01');
    // Send ONLY the redacted body to the gateway; the vendor log stays clean.
    const out = await infer({ task: 'retro_draft', prompt: source.redacted_body });
    const restored = restore(out.text, rec.redaction_map);
    const draft = await createDraft({
      kind: 'retro_draft', level: 'L2', status: 'pending_review',
      drafter, subject: '会后回顾草稿', body: restored,
      redacted_body: out.text, placeholders: rec.draft.placeholders || [],
    });
    return res.status(201).json({ ok: true, draft: remember('retro_draft', draft, { redaction_map: rec.redaction_map }) });
  } catch (e) {
    return res.status(502).json({ code: 'RETRO_FAILED', message: e.message });
  }
});

app.post(`${API}/reset`, (_req, res) => {
  records = new Map();
  outbound = [];
  blocked = [];
  return res.json({ ok: true, service: 'operations-assistant' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[operations-assistant] listening on http://0.0.0.0:${PORT}`);
});
