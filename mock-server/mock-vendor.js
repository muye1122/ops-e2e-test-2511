/**
 * Deterministic mock model vendor.
 *
 * Records EVERY request body it receives to mock-vendor-requests.log (JSONL).
 * The log is the evidence used by the acceptance suite to prove that no raw
 * phone number, e-mail address or non-public paragraph ever left the service.
 * All content is fictional; there is no real model call and no network egress.
 */
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_PATH = path.join(__dirname, '..', 'mock-vendor-requests.log');
const app = express();
app.use(express.json({ limit: '2mb' }));

const API = '/api/v1';
const PORT = process.env.VENDOR_PORT || 3004;
let requests = [];

function append(entry) {
  fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + '\n', 'utf8');
}
function reset() {
  requests = [];
  fs.writeFileSync(LOG_PATH, '', 'utf8');
}
// Make sure the log exists even before the first inference.
if (!fs.existsSync(LOG_PATH)) fs.writeFileSync(LOG_PATH, '', 'utf8');

app.get(`${API}/health`, (_req, res) => res.json({
  ok: true, service: 'mock-vendor', requests: requests.length, log: path.basename(LOG_PATH), ts: Date.now(),
}));

app.post(`${API}/generate`, (req, res) => {
  const body = req.body || {};
  const entry = {
    seq: requests.length + 1,
    ts: new Date().toISOString(),
    method: 'POST',
    path: `${API}/generate`,
    body,
  };
  requests.push(entry);
  append(entry); // full body, verbatim: the log must be able to catch a leak

  const task = String(body.task || '');
  const prompt = String(body.prompt || '');
  let text;
  if (task === 'activity_plan') {
    text = `活动方案：${prompt}。执行口径：虚构活动、虚构预算、等待人工复核。`;
  } else if (task === 'channel_copy') {
    text = `渠道文案（${body.channel || 'unspecified'}）：${prompt}。统一口径，等待人工复核。`;
  } else if (task === 'summarize_segment') {
    text = `摘要(${body.index ?? 0})：${prompt}`;
  } else if (task === 'merge_summary') {
    text = `会后总结：${prompt}`;
  } else if (task === 'retro_draft') {
    text = `回顾草稿：${prompt}；请后续跟进，等待人工复核。`;
  } else {
    text = `已生成：${prompt}`;
  }
  return res.json({ ok: true, vendor: 'deterministic-mock', text, request_seq: entry.seq });
});

app.get(`${API}/requests`, (_req, res) => res.json({ total: requests.length, requests }));
app.get(`${API}/audit/outbound`, (_req, res) => res.json({
  service: 'mock-vendor', outbound: [], blocked: [], send_calls: [],
  note: 'This service only receives inference requests; it makes no outbound call.',
}));
app.post(`${API}/reset`, (_req, res) => {
  reset();
  return res.json({ ok: true, service: 'mock-vendor', note: 'in-memory requests and JSONL log cleared' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[mock-vendor] listening on http://0.0.0.0:${PORT}  log=${LOG_PATH}`);
});
