/**
 * Model gateway (Express simulation).
 *
 * The only outbound destination is the deterministic mock vendor. It never
 * receives raw text directly from a browser: the operations service redacts
 * before calling /infer. Every outbound attempt is recorded in an audit log.
 */
import express from 'express';

const app = express();
app.use(express.json({ limit: '2mb' }));

const API = '/api/v1';
const PORT = process.env.GATEWAY_PORT || 3002;
const VENDOR_URL = process.env.VENDOR_URL || 'http://127.0.0.1:3004';

let outbound = [];
let blocked = [];
const sendCalls = []; // always empty: no send-type API exists in this topology
const ALLOWED = new Set(['mock-vendor']);

function targetOf(url) {
  try {
    const u = new URL(url);
    return u.port === '3004' ? 'mock-vendor' : `unknown:${u.host}`;
  } catch {
    return 'unknown';
  }
}

async function callVendor(body) {
  const url = `${VENDOR_URL}${API}/generate`;
  const target = targetOf(url);
  if (!ALLOWED.has(target)) {
    const rec = { ts: new Date().toISOString(), target, url, reason: 'OUTBOUND_NOT_ALLOWED' };
    blocked.push(rec);
    const err = new Error('OUTBOUND_NOT_ALLOWED');
    err.code = 'OUTBOUND_NOT_ALLOWED';
    throw err;
  }
  const rec = {
    ts: new Date().toISOString(), target, method: 'POST', url,
    purpose: 'model_inference', status: null,
  };
  outbound.push(rec);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  rec.status = res.status;
  const payload = await res.json();
  return { payload, status: res.status };
}

app.get(`${API}/health`, (_req, res) => res.json({
  ok: true, service: 'model-gateway', vendor: VENDOR_URL, ts: Date.now(),
}));

app.post(`${API}/infer`, async (req, res) => {
  const body = req.body || {};
  try {
    const { payload, status } = await callVendor(body);
    return res.status(status).json({
      ok: true,
      service: 'model-gateway',
      text: payload.text || '',
      vendor_request_seq: payload.request_seq || null,
    });
  } catch (e) {
    return res.status(502).json({ ok: false, code: e.code || 'GATEWAY_ERROR', message: e.message });
  }
});

app.get(`${API}/audit/outbound`, (_req, res) => res.json({
  service: 'model-gateway', outbound, blocked, send_calls: sendCalls,
}));
app.post(`${API}/reset`, (_req, res) => {
  outbound = [];
  blocked = [];
  return res.json({ ok: true, service: 'model-gateway' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[model-gateway] listening on http://0.0.0.0:${PORT} -> ${VENDOR_URL}`);
});
