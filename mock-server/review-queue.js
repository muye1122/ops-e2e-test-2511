/**
 * Human review queue (Express simulation, in-memory rows).
 *
 * Transition rules:
 *   create        -> pending_review
 *   confirm       -> effective (employee acknowledgement, any actor)
 *   approve       -> effective, but an L2 item may NOT be approved by its drafter
 *                    (SELF_APPROVAL_FORBIDDEN); L1 may be self-approved.
 * The queue never performs an outbound call.
 */
import express from 'express';
import crypto from 'crypto';

const app = express();
app.use(express.json({ limit: '2mb' }));

const API = '/api/v1';
const PORT = process.env.REVIEW_PORT || 3003;
let drafts = [];
const outbound = [];
const blocked = [];
const sendCalls = [];

const now = () => new Date().toISOString();

app.get(`${API}/health`, (_req, res) => res.json({
  ok: true, service: 'review-queue', drafts: drafts.length, ts: Date.now(),
}));

app.post(`${API}/drafts`, (req, res) => {
  const d = req.body || {};
  const ts = now();
  const draft = {
    id: d.id || `draft_${crypto.randomBytes(5).toString('hex')}`,
    kind: String(d.kind || 'generic'),
    channel: d.channel || null,
    level: d.level === 'L1' ? 'L1' : 'L2',
    status: 'pending_review',
    drafter: String(d.drafter || ''),
    approver: null,
    subject: String(d.subject || ''),
    body: String(d.body || ''),
    redacted_body: String(d.redacted_body || ''),
    placeholders: Array.isArray(d.placeholders) ? d.placeholders : [],
    created_at: ts,
    updated_at: ts,
    history: [{ action: 'create', actor: d.drafter || '', ts }],
  };
  drafts.push(draft);
  return res.status(201).json({ ok: true, draft });
});

app.get(`${API}/drafts`, (_req, res) => res.json({ total: drafts.length, drafts }));
app.get(`${API}/drafts/:id`, (req, res) => {
  const d = drafts.find((x) => x.id === req.params.id);
  if (!d) return res.status(404).json({ code: 'DRAFT_NOT_FOUND', message: 'draft not found' });
  return res.json({ ok: true, draft: d });
});

function transition(req, res, action) {
  const d = drafts.find((x) => x.id === req.params.id);
  if (!d) return res.status(404).json({ code: 'DRAFT_NOT_FOUND', message: 'draft not found' });
  if (d.status !== 'pending_review') {
    return res.status(409).json({ code: 'INVALID_STATE', message: `cannot ${action} a ${d.status} draft` });
  }
  const actor = String(req.body?.actor || '');
  if (action === 'approve' && d.level === 'L2' && actor && actor === d.drafter) {
    return res.status(403).json({
      code: 'SELF_APPROVAL_FORBIDDEN',
      message: 'An L2 draft cannot be approved by its own drafter; a supervisor is required.',
      draft_id: d.id,
    });
  }
  d.status = 'effective';
  d.approver = actor || (action === 'confirm' ? 'employee' : 'supervisor');
  d.updated_at = now();
  d.history.push({ action, actor: d.approver, ts: d.updated_at });
  return res.json({ ok: true, draft: d });
}

app.post(`${API}/drafts/:id/confirm`, (req, res) => transition(req, res, 'confirm'));
app.post(`${API}/drafts/:id/approve`, (req, res) => transition(req, res, 'approve'));

app.get(`${API}/audit/outbound`, (_req, res) => res.json({
  service: 'review-queue', outbound, blocked, send_calls: sendCalls,
}));
app.post(`${API}/reset`, (_req, res) => {
  drafts = [];
  return res.json({ ok: true, service: 'review-queue' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[review-queue] listening on http://0.0.0.0:${PORT}`);
});
