# 代码与运行逻辑

## 模块边界

| 模块 | 职责 |
| --- | --- |
| `receiver.mjs` | 配置校验、单实例锁、SDK 长连接和后台循环装配 |
| `feishu-events.mjs` / `receive-service.mjs` | 事件解析、配对身份校验、指令分类、快速持久化 |
| `store.ts` | 收件、队列、投递状态、执行结果与回传事务 |
| `desktop-config.mjs` / `targets.mjs` | 本机任务标识、初始允许任务、用户显式选择的任务 |
| `desktop-adapter.mjs` | 发现入口、协议握手、任务身份验证和桌面调用 |
| `desktop-worker.mjs` / `multi-worker.mjs` | 固定目标调度、送达核验、执行状态和回复读取 |
| `delivery-evidence.mjs` / `rollout-evidence.mjs` | 新轮次委托原文确认、本机记录中的完整内容补全 |
| `projects.mjs` | 项目/全局列表、有效期、编号选择及退出后的投递保护 |
| `tasks.mjs` | 数据库初始化、任务名称和选择修订号 |
| `creation-adapter.mjs` / `creation-worker.mjs` | 创建请求持久化、目标冻结、创建结果核验 |
| `incoming-files.mjs` | 消息资源下载、限制、快照、路径验证和附件登记 |
| `reply-sender.mjs` / `reply-format.mjs` | 回传计划、格式化、分段、上传/发送幂等标识和降级 |
| `artifacts.mjs` | 明确输出链接的文件筛选、快照、上传及回传 |
| `mermaid-renderer.mjs` / `render-mermaid-child.mjs` | 独立浏览器进程中的本地渲染 |
| `usage.mjs` | 独立用量查询，账户数据不送进任务提示词 |
| `stop-worker.mjs` | 未接线的实验控制器；不代表停止功能可用 |

## 收件与指令

事件处理不等待桌面执行。它先验证应用、消息类型、私聊和配对身份，再在事务中保存 inbox 与需要的回执，以飞书消息 ID 去重。同 ID 内容冲突会被拒绝。

普通消息固定保存接收时的目标。控制命令标为 `cancelled`，表示不进入任务投递队列，不表示用户操作失败。查询/项目/创建分别使用独立工作记录和回传记录。

`/rc project 0` 切回全局，`global_selection_pending` 阻止后续正文继续进入旧项目。编号列表有有效期；选择修订号防止较慢的旧操作覆盖新的选择。项目创建请求冻结目标信息，调用前重新核验。

## 投递与执行

```text
received → queued → delivering → delivered
                         ├─ delivery_unknown（先对账，不重发）
                         └─ delivery_failed
控制命令或明确不投递 → cancelled
```

`received` 是已持久化事实，数据库投递状态从 `queued` 开始。执行状态独立保存：`not_started`、`unknown`、`completed`、`failed`、`interrupted` 等；工作进度另由 worker 观察。

领取前检查目标空闲、暂停、旧的不确定投递和附件准备状态。发送前保存基线轮次 ID；只有新轮次里出现匹配来源和完整原文的委托记录才确认送达。网络返回成功不是唯一凭据。

后台循环包括收件回传、桌面任务、创建、附件、用量和项目指令。它们可并行等待 I/O，但 SQLite 事务内不等待网络。

## 附件与回传

附件先保存 metadata，下载流按实际字节数限额，快照保存 SHA256。确认目录和文件身份后独占写入；不会覆盖已有内容。桌面投递前再次检查。普通文字仍保留原文，只有附件登记生成路径说明。

最终回复、附件快照和 outbox 在事务中保存。`reply_payloads` 记录已准备的消息类型、分段正文、UUID、发送尝试及远端 ID。首次尝试后不改写载荷；仅明确内容拒绝时才生成持久化文字降级。

## 兼容性与维护

- 现有 `desktop-test` 是历史运行模式名；更名需兼容本机配置和迁移标记。
- 当前协议来自桌面自带工具，不是承诺稳定的公共远控协议。
- 协议握手可在已核验同一桌面进程归属的管道间尝试；实际发送不在该重试循环里。
- `sourceThreadId`、初始目标及可选 `bootstrapTasks` 都来自私有配置。离线测试无配置时使用合成 UUID。
- 初次从收件模式启用桌面模式，会取消启用前尚未投递的旧队列，防止历史测试文字突然执行。
- 更新数据库前备份 `.private/`；不要在活跃接收器之外调用 `recover()`。
- 回归测试使用本地临时目录和模拟适配器，不自动向真实飞书或桌面任务发消息。
- 新协议版本应额外完成独立进程读取、无害发送、上下文接续和终态读取验收；离线测试通过不能替代它。

