# 测试用例 × 结果矩阵

执行命令：`npm test`（Node 22.22.2 / npm 10.9.7 / Playwright `channel: 'msedge'`），本机一次运行 **8 passed (7.3s)**。所有数据均为虚构。

## 四组验收用例

| 组 | 用例 | 关键断言 | 结果 |
|---|---|---|---|
| G1 | 活动方案：生成→待复核→员工确认→生效→导出 Word 返回 200 | 初始 `pending_review`；员工确认后 `effective`；导出 HTTP 200 且 `Content-Type: application/msword` | passed |
| G2 | 四渠道文案：全 L2、起草人自审被拒、主管审批后生效 | 四渠道均为 L2；自审返回 `SELF_APPROVAL_FORBIDDEN`（403）；主管审批后四条均 `effective` | passed |
| G3 | 会后总结：分段汇总→L1 生效→生成 L2 回顾草稿 | 7 段分段汇总；L1 自审允许并生效；回顾草稿为 L2 且 `pending_review` | passed |
| G3 | 脱敏断言：供应商请求日志无原始手机号、邮箱与非公开段落 | JSONL 日志与 API 双路读取；原始手机号/邮箱/非公开段落/标记串均不出现 | passed |
| G3 | 还原断言：草稿中手机号与邮箱被还原，非公开段落不出现 | L1 总结与 L2 回顾草稿均含原始虚构手机号与邮箱；非公开段落始终不出现 | passed |
| G4 | 零外发：运营辅助服务只访问网关与复核队列 | `targets === ['model-gateway','review-queue']`；网关出口仅指向 mock 供应商 | passed |
| G4 | 白名单与 send 类调用：所有容器拦截日志为空且无外发 API | 四个服务的 `blocked` 与 `send_calls` 均为空；外部/send 目标被纯评估拒绝且不污染日志 | passed |

## 补充演示用例

| 用例 | 关键断言 | 结果 |
|---|---|---|
| 演示界面：展示复核状态与零外发计数 | Edge 打开 React 页面，点击运行演示后四渠道计数为 4、生效计数为 5、违规外发与拦截计数为 0 | passed |

## 证据文件

- `test-results/results.json`：Playwright JSON 报告（运行时生成），CI 会据此打印上表。
- `mock-vendor-requests.log`：mock 供应商全量请求体 JSONL（运行时生成）。最后一次运行含 5 条请求（一次活动方案 + 四渠道文案），对虚构手机号、邮箱与非公开段落的检索为 0 命中。
- `验证记录.md`：真实命令输出与逐项验收对应。

## CI 输出方式

`.github/workflows/e2e.yml` 在 `npm test` 后以 `if: always()` 读取 JSON 报告并逐行打印 `| 用例 | 结果 |` 表格，随后独立复跑日志脱敏检索，失败即让流水线失败。
