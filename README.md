# AI 提示词共享库（AI Prompt Shared Library）

> 【共享库作者为graceshen/codex/deepseek/claude，开源项目，不收费，如有人以不同形式复传盗卖共享库核心功能，请立马退款，并搜索免费版下载，codex/workbuddy插件搜索（AI提示词共享库/AI Prompt Shared Library），其他渠道github搜索以上关键词让agent协助下载安装，我们这个项目主旨是普惠大众，共享便利】

AI 提示词共享库：内置精选提示词 + 全量库（2,000+ 条，离线可用）+ 用户自定义 + 社区共享（GitHub Gist）。单文件前端、零依赖、可 `file://` 直开；附带本地 HTTP 服务、Claude Code 客户端、Token 用量统计与权限管理。

搜索关键词：**AI提示词共享库 / AI Prompt Shared Library / prompt-palette**。

## 安装（Codex 插件）

```bash
# 添加公开市场（只需一次）
codex plugin marketplace add https://github.com/graceshen/AI-Prompt-Shared-Library
# 安装插件
codex plugin add prompt-palette@prompt-palette
```

安装后打开工作台：`http://127.0.0.1:1190/app`（本地服务自动/手动启动）。

## 安装（WorkBuddy）

将 `plugins/prompt-palette` 复制到 WorkBuddy 的 `plugins/cache/workbuddy-builtin/prompt-palette/<版本>/`，重启 WorkBuddy 即可在插件列表看到“AI 提示词共享库”。

## 使用

- 双击打开工作台（或本地服务 `/app`），首次打开自动加载内置全量库，无需登录 GitHub；
- 收藏、分类、搜索（模糊/错字容错/多语言）、翻译、导出 CSV/Markdown/JSON；
- 社区共享库（母库+子库）与私有 Gist 同步；
- Claude 客户端：`http://127.0.0.1:1190/claude`（多对话窗口、Token 用量、权限模式）。

## 本地服务（Windows / macOS）

```bash
node assets/server.mjs            # 默认 127.0.0.1:1190
node assets/server.mjs --port 2000
```

环境变量：
- `PP_DATA_DIR`：数据目录（默认 `~/Documents/Codex/prompt-palette-data`）
- `PP_CLAUDE_BIN`：Claude Code CLI 路径（默认 Windows 用 npm 全局 `claude.exe`，macOS/Linux 用 PATH 中的 `claude`）
- `PP_CCSWITCH_DB`：CC Switch 用量数据库路径（Token 用量统计用，可选）
- `PP_CLAUDE_SETTINGS`：Claude Code 权限配置文件路径（可选）

## 测试

```bash
cd plugins/prompt-palette
node test/server.test.mjs     # 安全回归 24 项
node test/frontend.test.mjs   # 前端逻辑回归 31 项
```

## 开源说明

MIT License。项目主旨：普惠大众、共享便利、不收费。
