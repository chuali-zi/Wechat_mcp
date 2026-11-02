# 本地微信 + QQ MCP

本项目提供本地 stdio MCP 服务，读取已准备的微信和 QQ NT 本机聊天记录及微信附件；不发送消息、不提供 HTTP 服务。QQ 支持文本读取，尚未解析的媒体和内容会标明局限。服务读取本机配置和数据库；导出和媒体解码会在本机生成输出或缓存。首次读取前需要准备兼容的账号配置及密钥，服务不会自动提取密钥。

## 安装与运行（Windows）

需要 Node.js 22+、Python 虚拟环境及对应的微信/QQ 本机数据和密钥。项目保留默认数据目录 `%APPDATA%\WeFlow-full`，包括微信配置、backend 状态和 `qq-config.json`；升级前备份这些本地数据。现有客户端配置和 `weflow-mcp.cmd` 路径继续有效。

```powershell
py -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r python\requirements.txt
npm install
npm run build:mcp
.\weflow-mcp.cmd --ensure
```

构建输出为 `build/mcp/server.cjs`。`weflow-mcp.cmd` 启动 stdio 服务；`--check` 做一次独立的微信连接检查，`--qq-check` 检查 QQ，`--ensure` 检查构建、Python、微信、QQ 及客户端配置，不启动常驻服务。检查成功后重新连接 MCP 客户端并调用 `get_status`。`--print-config` 可输出客户端配置；路径移动后需重新生成配置。不要把配置、数据库或密钥上传。

QQ 配置默认在 `%APPDATA%\WeFlow-full\qq-config.json`，也可使用 `WEFLOW_QQ_CONFIG` 指定文件。配置包含数字字符串 `uin`，可选绝对路径 `db_dir`、`key_file` 和 `hmac`；密钥文件是包含 `password` 的 JSON。未指定 `db_dir` 时按本机 QQ 数据目录查找。密钥不会出现在工具参数中。可选的显式只读密钥发现工具为 `python -m qqhistory.prepare --config <配置文件> --output <新密钥文件>`，先设置 `PYTHONPATH` 为项目的 `python` 目录；它不会由 MCP 自动调用，也不会覆盖已有文件。

微信工具先调用 `get_status` 和 `find_chats`，再使用 `read_messages`、`list_attachments` 和 `get_attachment` 等；QQ 使用 `qq_get_status`、`qq_find_chats`、`qq_read_messages`、`qq_search_messages`。工具返回的覆盖范围和未解析内容应纳入结果判断。`first_seen_at` 是最早本地消息时间，不是确定的建群时间或创建者证据。

## 开发检查

```powershell
npm run typecheck
npm run test:mcp
npm run test:qq
```

源码入口在 `mcp/`；`shared/` 是共享模型和启动辅助代码，`python/` 是只读数据库后端及 QQ 密钥工具，`scripts/` 包含构建、测试和启动检查。构建后客户端需重新连接。

## 来源与许可

本项目源自 [hicccc77/WeFlow](https://github.com/hicccc77/WeFlow)；完整应用快照位于本仓库的 [weflow-app 分支](https://github.com/chuali-zi/Weflow_full/tree/weflow-app)。保留原作者署名和 [LICENSE](LICENSE)；第三方 SQLCipher 许可见 [docs/licenses/sqlcipher3.txt](docs/licenses/sqlcipher3.txt)。
