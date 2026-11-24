import React, { useEffect, useState } from 'react';

const API = '/api/v1';
const CHANNELS = ['wechat', 'sms', 'email', 'in_app'];

async function jsonPost(url, data) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return res.json();
}

export default function App() {
  const [records, setRecords] = useState([]);
  const [audit, setAudit] = useState({ outbound: [], blocked: [], send_calls: [] });
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  async function refresh() {
    const [r, a] = await Promise.all([
      fetch(`${API}/records`).then((x) => x.json()),
      fetch(`${API}/audit/outbound`).then((x) => x.json()),
    ]);
    setRecords(r.records || []);
    setAudit(a);
  }

  useEffect(() => {
    refresh().catch((e) => setMsg(String(e)));
  }, []);

  async function runDemo() {
    setBusy(true);
    setMsg('');
    try {
      const plan = await jsonPost(`${API}/activity-plans/generate`, {
        title: '演示活动方案（虚构）', drafter: 'editor-01',
      });
      await jsonPost(`${API}/activity-plans/${plan.draft.id}/confirm`, { actor: 'employee-01' });
      for (const channel of CHANNELS) {
        const copy = await jsonPost(`${API}/channel-copies/generate`, { channel, drafter: 'editor-01' });
        await jsonPost(`${API}/channel-copies/${copy.draft.id}/approve`, { actor: 'supervisor-01' });
      }
      await refresh();
      setMsg('演示完成：活动方案已由员工确认，四渠道文案已由主管审批。全部数据为虚构。');
    } catch (e) {
      setMsg(`演示失败：${e.message || e}`);
    } finally {
      setBusy(false);
    }
  }

  const copies = records.filter((r) => r.kind === 'channel_copy');
  const effective = records.filter((r) => r.draft.status === 'effective');
  const illegal = (audit.blocked || []).length + (audit.send_calls || []).length;
  const gatewayCalls = (audit.outbound || []).filter((o) => o.target === 'model-gateway').length;
  const reviewCalls = (audit.outbound || []).filter((o) => o.target === 'review-queue').length;

  return (
    <div className="page">
      <header>
        <h1>运营辅助 · 端到端验收演示</h1>
        <p className="lead">生成 → 复核 → 生效 · 发送前脱敏 · 草稿还原 · 零外发聚合审计</p>
      </header>

      <div className="banner" data-testid="demo-banner">
        演示边界：全部数据为虚构；仅在服务内部调用模型网关与复核队列；手机号与邮箱在发往网关前替换为占位符，草稿中还原；非公开段落永不进入模型请求。
      </div>

      <section className="grid">
        <div className="card">
          <h2>演示控制台</h2>
          <button data-testid="demo-run-btn" onClick={runDemo} disabled={busy}>
            {busy ? '运行中…' : '运行演示流程'}
          </button>
          <p className={msg.startsWith('演示失败') ? 'error' : 'hint'} data-testid="demo-msg">{msg || '点击按钮生成一条活动方案与四渠道文案并完成复核。'}</p>
          <div className="metrics">
            <div><span>复核记录</span><strong data-testid="record-count">{records.length}</strong></div>
            <div><span>四渠道文案</span><strong data-testid="channel-count">{copies.length}</strong></div>
            <div><span>已生效</span><strong data-testid="effective-count">{effective.length}</strong></div>
          </div>
        </div>

        <div className="card">
          <h2>出口审计（聚合）</h2>
          <div className="metrics">
            <div><span>违规外发</span><strong data-testid="outbound-count">{illegal}</strong></div>
            <div><span>白名单拦截</span><strong data-testid="blocked-count">{(audit.blocked || []).length}</strong></div>
            <div><span>网关调用</span><strong data-testid="gateway-calls">{gatewayCalls}</strong></div>
            <div><span>复核队列调用</span><strong data-testid="review-calls">{reviewCalls}</strong></div>
          </div>
          <p className="hint">允许目标：model-gateway、review-queue。任何其他目标与 send 类 API 均被拒绝。</p>
        </div>
      </section>

      <section className="card">
        <h2>复核队列快照</h2>
        <table data-testid="records-table">
          <thead>
            <tr><th>类型</th><th>渠道</th><th>级别</th><th>状态</th><th>标题</th></tr>
          </thead>
          <tbody>
            {records.map((r) => (
              <tr key={r.draft.id}>
                <td><code>{r.kind}</code></td>
                <td>{r.channel || '—'}</td>
                <td>{r.draft.level}</td>
                <td><span className={`tag ${r.draft.status}`}>{r.draft.status}</span></td>
                <td className="clip">{r.draft.subject}</td>
              </tr>
            ))}
            {records.length === 0 && (
              <tr><td colSpan="5" className="hint">暂无记录，点击“运行演示流程”。</td></tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}
