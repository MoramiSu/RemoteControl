# 飞书应用配置

使用企业自建应用机器人，不是群自定义 Webhook 机器人。

1. 在[飞书开放平台](https://open.feishu.cn/app)创建企业自建应用，并开启机器人能力。
2. 设置应用可用范围为本人，确认自己能与机器人私聊。
3. 在权限管理中开通私聊收件、机器人发消息能力。通常对应 `im:message.p2p_msg:readonly` 和 `im:message:send_as_bot`；以平台实际显示和审批要求为准。
4. 附件收发需要 `im:resource`。本项目实际下载消息资源时还要求 `im:message:readonly` 或更广的 `im:message`，只有上传权限不够。
5. 事件与回调选择**使用长连接接收事件**，订阅 `im.message.receive_v1`。如果平台要求先建立连接，就先完成本机配置并启动接收器，然后保存订阅。
6. 按平台提示创建版本、发布并完成管理员审批。已经开通不等于一定已对当前应用版本生效。
7. 在应用凭证页面取得 App ID 和 App Secret，仅在本机配置脚本中输入。不要发给聊天助手、贴入 issue 或提交仓库。
8. 接收器首次启动后显示一次性配对命令，只发送到自己的机器人私聊。成功后程序固定该租户、用户和聊天 ID；应用可见范围不能替代程序的身份校验。

家中电脑通过应用凭据连接飞书开放平台，不需要登录飞书客户端。网络仍须允许访问飞书 API 和长连接服务。不要在多台电脑启动同一应用接收器。

如果失败，优先查看 `.private/status.json` 中的连接状态，以及终端的简短错误。不要为排错公开整个 `.private/` 目录；数据库包含用户消息、任务绑定和回传内容。

参考：[官方 Node SDK](https://github.com/larksuite/node-sdk)、[接收消息事件](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive)、[消息资源下载](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message-resource/get)。
