# 本地微信 + QQ MCP 工作约定

本仓库是本地只读微信和 QQ MCP 服务，不是桌面应用。保持 MCP 工具名称、协议、`%APPDATA%\WeFlow-full` 用户数据与 `qq-config.json`、`weflow-mcp.cmd` 入口及 `build/mcp/server.cjs` 的兼容性。

MCP 不可用时在仓库根目录运行 `weflow-mcp.cmd --ensure`，按 JSON 状态修复后重新连接 MCP 客户端并调用 `get_status`。此检查不建立常驻服务，也不会自动获取密钥。`first_seen_at` 是最早本地消息时间，不能作为确定的建群时间或创建者证据。不要输出聊天内容、姓名或密钥作为诊断日志。
