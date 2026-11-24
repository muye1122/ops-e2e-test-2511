# 运营辅助 · 端到端集成测试

可运行交付：四个 Express 服务模拟运营辅助、模型网关、复核队列与记录全量请求的 mock 供应商；Playwright 端到端用例覆盖活动方案、四渠道文案、会后总结脱敏还原与零外发聚合审计。React 18 + Vite 6 仅作人工演示界面。全部业务数据为虚构。

## 1. 一条命令跑完全部用例

先安装一次依赖（仓库已带 lockfile）：

```bash
npm ci
```

之后 **一条命令** 跑完全部端到端用例（Playwright 自动拉起四个服务与前端，使用系统 Edge，不下载 Chromium）：

```bash
npm test
```

样例运行输出（本机真实结果）：

```
> ops-assistant-e2e@1.0.0 test
> playwright test


Running 8 tests using 1 worker

  ok 1 tests\e2e.spec.js:80:1 › G1 活动方案：生成→待复核→员工确认→生效→导出 Word 返回 200 (151ms)
  ok 2 tests\e2e.spec.js:114:1 › G2 四渠道文案：全 L2、起草人自审被拒、主管审批后生效 (94ms)
  ok 3 tests\e2e.spec.js:164:1 › G3 会后总结：分段汇总→L1 生效→生成 L2 回顾草稿 (67ms)
  ok 4 tests\e2e.spec.js:200:1 › G3 脱敏断言：mock 供应商请求日志文件无原始手机号、邮箱与非公开段落 (58ms)
  ok 5 tests\e2e.spec.js:226:1 › G3 还原断言：草稿中手机号与邮箱被还原，非公开段落不出现 (47ms)
  ok 6 tests\e2e.spec.js:247:1 › G4 零外发：运营辅助服务只访问网关与复核队列 (102ms)
  ok 7 tests\e2e.spec.js:264:1 › G4 白名单与 send 类调用：所有容器拦截日志为空且无外发 API (106ms)
  ok 8 tests\e2e.spec.js:300:1 › 演示界面：展示复核状态与零外发计数 (535ms)

  8 passed (7.3s)
```

结果矩阵见 `results-matrix.md`；逐条命令与证据见 `验证记录.md`。

## 2. 文件清单

| 路径 | 作用 |
|---|---|
| `mock-server/ops.js` | 运营辅助：流程编排、发送前脱敏、草稿还原、外发白名单与出口审计 |
| `mock-server/gateway.js` | 模型网关：唯一出口为 mock 供应商，记录自身出站请求 |
| `mock-server/review-queue.js` | 复核队列：内存草稿、`pending_review`/`effective` 流转、L2 禁止自审 |
| `mock-server/mock-vendor.js` | mock 供应商：确定性生成，全量请求体写入 `mock-vendor-requests.log` |
| `tests/e2e.spec.js` | 四组端到端用例 + 演示界面检查 |
| `src/`, `index.html`, `vite.config.js` | React 18 + Vite 6 演示界面 |
| `playwright.config.js` | 自动拉起 3001/3002/3003/3004/5173，`channel: 'msedge'` |
| `server.js` | 一体化本地启动器（API 3001 + 构建产物 4173） |
| `Dockerfile`, `docker-compose.yml` | 六服务容器编排（含 PostgreSQL 16 与 Redis 声明） |
| `.github/workflows/e2e.yml` | CI：安装、构建、跑测试、打印用例矩阵、复跑日志脱敏检索 |
| `mock-vendor-requests.log` | **运行时生成**：供应商收到的全部请求体（JSONL） |
| `test-results/results.json` | **运行时生成**：Playwright 机器可读报告 |

`package-lock.json` 随仓提交以固定依赖版本。

## 3. 架构与数据流

| 服务 | 端口 | 说明 |
|---|---|---|
| operations-assistant | 3001 | 唯一面向测试/前端的入口；只能访问网关与复核队列 |
| model-gateway | 3002 | 把推理请求转发给 mock 供应商，记录出站日志 |
| review-queue | 3003 | 人工复核队列；不外发 |
| mock-vendor | 3004 | 记录每一个请求体到 JSONL 日志；零网络外发 |

调用链：`测试/前端 → 运营辅助 → 模型网关 → mock 供应商`；草稿另经 `运营辅助 → 复核队列` 落库。运营辅助的 `egress()` 是唯一出口函数，目标不在白名单或 URL 含 send/notify/webhook/message/email 时直接拒绝并记录，但正常全流程中拦截列表保持为空。

## 4. 四组用例说明

1. **活动方案**：生成得到 `pending_review`，员工确认后 `effective`，Word 导出返回 200（`application/msword`）。
2. **四渠道文案**：`wechat/sms/email/in_app` 全部 L2；起草人自审返回 `403 SELF_APPROVAL_FORBIDDEN`；主管审批后四条全部生效。
3. **会后总结**：含虚构手机号、邮箱与 `【非公开】` 段落的纪要按行分段汇总；脱敏在**首次网关调用之前**完成；L1 生效后生成 L2 回顾草稿。测试同时断言供应商日志无原始敏感串、而草稿中手机号/邮箱被还原、非公开段落始终不出现。
4. **零外发**：聚合四个服务 `/api/v1/audit/outbound`，断言运营辅助目标集合恰为 `model-gateway` 与 `review-queue`，所有服务 `blocked` 与 `send_calls` 为空；另有纯评估接口证明外部/send 目标会被拒绝，且评估本身不产生请求、不污染日志。

## 5. 脱敏与还原机制

- 手机：`1[3-9]\d{9}` → `[PHONE_n]`；邮箱 → `[EMAIL_n]`；整行 `【非公开】` → `[PRIVATE_n]`。
- 可逆映射只存在运营辅助内存；网关与供应商只看到占位符。
- 生成草稿时仅还原 PHONE/EMAIL 占位，PRIVATE 占位保持不还原，因此非公开段落既不进入模型请求，也不进入草稿。
- mock 供应商日志逐行写入完整请求体，验收测试直接读文件并做字符串检索（另经 API 复核）。

## 6. 容器与 CI

本地验收以 npm 为准；容器编排用于部署形态演示：

```bash
docker compose up --build
# 四个 API 端口为 3001/3002/3003/3004；演示界面在宿主另跑 npm run dev（5173）
```

`postgres16` 与 `redis` 在编排中声明，供生产替换点使用；**本演示不连接它们**（数据层为内存 Map/数组），因此不需要初始化 schema。本环境未安装 Docker CLI，容器编排未在本地执行；交付的配置与 `docker compose` 命令可用于有 Docker 的环境。

CI 在 `windows-latest` 上使用 Node 22、`npm ci`、`npm run build`、`npm test`，随后打印用例×结果矩阵并独立检索供应商日志；检出敏感串即失败。

## 7. 演示边界（诚实声明）

- 所有企业、活动、联系人、手机号、邮箱与段落均为虚构；无真实个人信息、无外部数据集。
- 不调用真实模型、不连接真实数据库/Redis、不实现真实认证、不发送任何消息。
- Word 导出为 Word 2003 XML（`application/msword`）演示实现，不是完整 `.docx` 打包。
- 复核状态流转为内存模拟；L2 禁止自审规则在复核队列服务中强制执行。
- 这是端到端验收演示，不是生产系统；第 8 节列出工程化替换点。

## 8. 替换点

1. 数据层：`ops.js` 的 `records`、`review-queue.js` 的 `drafts` 替换为 PostgreSQL 16 表；Redis 用于占位符可逆映射的短期缓存，需设置 TTL 并限制访问。
2. 网关：`gateway.js` 的 `VENDOR_URL` 指向私有网关；保留运营辅助的出口白名单与“先脱敏后发送”顺序。
3. 复核：接入真实人工工作台时保留 `SELF_APPROVAL_FORBIDDEN` 与状态审计。
4. 外发：若未来引入通知能力，应作为独立高权限服务，经人工批准后执行，且不得由运营辅助直接调用。
