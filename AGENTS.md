# MCP 工作约定

MCP 不可用时在仓库根目录运行 `weflow-mcp.cmd --ensure`，按 JSON 状态修复后重新连接 MCP 客户端并调用 `get_status`。此检查不建立常驻服务，也不会自动获取密钥。`first_seen_at` 是最早本地消息时间，不能作为确定的建群时间或创建者证据。
