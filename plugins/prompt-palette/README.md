# AI 提示词工作台（prompt-palette）

> 【共享库作者为graceshen/codex/deepseek/claude，开源项目，不收费，如有人以不同形式复传盗卖共享库核心功能，请立马退款，并搜索免费版下载，codex/workbuddy插件搜索（AI提示词共享库/AI Prompt Shared Library），其他渠道github搜索以上关键词让agent协助下载安装，我们这个项目主旨是普惠大众，共享便利】

AI 提示词共享库：内置精选提示词 + 用户自定义 + 社区共享（GitHub Gist）。单文件前端、零依赖、可 `file://` 直开，附带本地 HTTP 服务与命令行检索脚本。

---

## 一、快速开始

### 1. 打开工作台

```bash
# 方式 A：本地 HTTP 服务（推荐，支持深链 /app?prompt=<ID>、libs 白名单）
node assets/server.mjs
#   默认端口 1190；占用自动换端口；运行信息写入用户数据目录 server-info.json
#   浏览器打开 http://127.0.0.1:<端口>/app

# 方式 B：直接双击打开单文件（离线兜底）
#   assets/AI提示词工作台.html
```

### 2. 命令行检索（给 agent 用）

```bash
node assets/search_prompt.mjs "SQL 优化"                # 默认输出前 5 条标题
node assets/search_prompt.mjs "周报" --category write   # 限定分类
node assets/search_prompt.mjs "数据分析" --full --limit 1  # 输出完整正文
node assets/search_prompt.mjs "配色" --json             # JSON 输出
node assets/search_prompt.mjs "git" --estimate          # 预估 token 费用
```

检索脚本会自动拉起本地服务（默认 1190），并可选拉起 DeepLX 翻译（1188）与翻译代理（1189）。

### 3. 运行测试

```bash
node test/server.test.mjs     # 服务端集成测试：CORS / 路径穿越 / schema 校验 / 原子写入（24 项）
node test/frontend.test.mjs   # 前端核心逻辑单测：转义 / Gist ID 校验 / 搜索 / 去重（31 项）
```

> 测试均为自包含：server 测试用独立端口（13190）+ 临时数据目录，跑完自动清理，不影响你的真实数据目录。

---

## 二、目录结构与数据流

```
prompt-palette/
├── assets/
│   ├── AI提示词工作台.html    # 单文件工作台（主脚本内嵌，约 32 万字节）
│   ├── server.mjs             # 本地 HTTP 服务（见下方「安全模型」）
│   ├── search_prompt.mjs      # CLI 检索脚本（供 agent 调用）
│   ├── prompts.json           # 内置提示词（82 条，{id,c,t,tags,p}）
│   ├── prompts.csv            # 内置提示词 CSV（导出/兼容用）
│   ├── libs/                  # 本地文档解析库（mammoth/xlsx/pdfjs，白名单）
│   ├── sw.js                  # Service Worker（仅缓存静态资源，豁免 /data/）
│   └── manifest.webmanifest
├── skills/prompt-palette/     # agent 规则（SKILL.md）
├── test/                      # 自动化测试
└── .codex-plugin/plugin.json  # 插件清单
```

**数据流**：

```
工作台（浏览器）
 ├─ localStorage        用户私有状态（收藏/自定义/分类/设置）
 │    ├─ apw_customs_v1 / apw_favs_v1      自定义提示词 + 收藏
 │    ├─ apw_gist_v1 / apw_deepseek_v1     GitHub Token / DeepSeek Key（明文，见「已知取舍」）
 │    └─ apw_community_cfg_v1 / apw_sublibs_v1   社区库 Gist ID 配置
 ├─ 本地服务 server.mjs   （读写用户数据目录）
 │    ├─ GET/POST /data/*                    <用户数据目录>/prompt-palette-data/
 │    ├─ GET /libs/<白名单库>                  assets/libs/
 │    └─ GET /app、/prompts.csv、/sw.js        静态资源
 └─ GitHub Gist API      社区共享库同步（母库 + 子库）
```

**用户数据目录**（默认 `Documents\Codex\prompt-palette-data\`，可用 `PP_DATA_DIR` 覆盖）：
- `user-prompts.json`：`{"version":1,"updatedAt":"…","customs":[…],"favorites":[…]}`（agent 与工作台共用）
- `workbench-state.json`：工作台收藏/社区库状态
- `server-info.json` / `server.lock` / `server.log`：服务运行信息、单实例锁、日志

---

## 三、安全模型

针对第三方审查报告（`AI提示词工作台-第三方审查报告.md`）已落实的修复：

| 项 | 风险 | 修复 | 验证 |
|----|------|------|------|
| CORS 过宽 | 任意网站读写本地数据 | `corsAllowed()`：仅放行 `file://`（Origin:null）、localhost/127.0.0.1/[::1]，其余 403 | server 测试 §CORS |
| `/data/` 路径穿越 | 兄弟目录前缀绕过 | `safePath()` 段边界校验 + 解码 try/catch（畸形编码不崩溃） | server 测试 §路径穿越 |
| `/libs/` 越界 | 可读插件目录外文件 | 白名单 4 个库 + 仅取 `basename` | server 测试 §libs |
| 解码异常 DoS | 畸形 URL 击穿进程 | 统一在 `safePath()` 内 try/catch，失败返回 null | server 测试 §畸形编码 |
| XSS（gistId） | 用户可控串拼 innerHTML | 所有 Gist ID 渲染处 `esc()`（含 `renderUploadTargets`/`renderUploadPick`） | 前端测试 §esc |

优化建议也已落实：`validGistId()`（20-32 位十六进制）输入校验、`POST /data/` schema 校验（400 拒绝脏数据）、`atomicWrite()` 临时文件+rename、`patchCommunityTarget()` 乐观合并（最多 3 轮 + updatedAt 回读校验）、`fuzzyPossible()` 搜索粗筛（不漏匹配）。

**关键边界**（务必保留）：
- `server.mjs` 中 `safePath`/`corsAllowed`/`validateDataPayload`/`atomicWrite` 是实现安全模型的核心，改动需回归 `test/server.test.mjs`。
- 前端所有把用户数据（标题/正文/标签/Gist ID）拼进 `innerHTML` 的地方都必须过 `esc()`。

### 已知取舍（不修）

- **Token/Key 明文存 localStorage**：纯前端单文件架构的固有取舍。配置串导出已 AES-256（PBKDF2 15 万轮 + AES-GCM）加密；输入框 `type="password"` + `autocomplete="new-password"`。剩余风险为「同源 XSS + 本机恶意软件」组合，属可接受范围。
- **`/data/` 写接口无鉴权**：本地单机工具设计使然（只绑定 127.0.0.1，且 CORS 已收紧）。
- **外部 CDN 加载解析库**：`loadDocLib()` 可从 jsDelivr 回源，供应链信任；本地已内置同名库兜底。

---

## 四、常见运维

| 需求 | 命令/操作 |
|------|-----------|
| 换端口 | `node server.mjs --port 2000` |
| 换数据目录 | 设环境变量 `PP_DATA_DIR` |
| 清理旧进程 | 查 `server-info.json` 的 pid，`kill`；或用 `server.lock` 确认 |
| 本地服务没起来 | `node server.mjs`，看 `server.log`；占用则自动换端口 |
| 加内置提示词 | 编辑 `assets/prompts.json`（保持 `{id,c,t,tags,p}` 结构） |
| 导出用户库 | 工作台「导出」→ CSV（act,prompt）/ Markdown |

---

## 五、开发注意

- 这是**纯 JavaScript** 项目（无 TypeScript 编译层），类型约定靠 JSDoc + 输入校验。关键函数已标注 `@param`/`@returns`（见 `server.mjs`）。
- 主脚本内嵌在 `AI提示词工作台.html` 的第一个 `<script>` 中（约 32 万字节）；改完用 `node --check` 提取该脚本验证语法：
  ```bash
  node -e "const h=require('fs').readFileSync('assets/AI提示词工作台.html','utf8');const m=h.match(/<script>([\s\S]*?)<\/script>/);require('fs').writeFileSync('/tmp/_pp.js',m[1])" && node --check /tmp/_pp.js
  ```
- 语法/逻辑/安全改动后跑 `test/server.test.mjs` 与 `test/frontend.test.mjs`，全绿再交付。
- **死代码只报告不删**（如 `findByCardId`）——遵循既有任务规则。
