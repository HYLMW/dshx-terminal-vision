# AnySearch Web Search（REST）接入说明

本分支补丁 C 让 DeepSeek Harness 内置的 `web_search` 工具可以直接使用 **AnySearch**（`https://api.anysearch.com/v1`）这类纯 REST 搜索网关，**不需要本地协议桥**。

## 背景

Harness 内置 `web_search` 工具的 provider（`@deepseek-ai/dsh-web-search-deepseek`）只讲 **Anthropic Messages + `web_search_20250305` 原生搜索工具** 协议，目标端点必须实现 Anthropic 消息接口。而 AnySearch 提供的是普通 JSON REST 接口：

```http
POST https://api.anysearch.com/v1/search
Authorization: Bearer as_sk_...
Content-Type: application/json

{ "query": "…" }
```

返回形如 `{ "data": { "results": [ { "title", "url", "snippet" } ] } }`。

此前只有两条路：要么让网关兼容 Anthropic 协议，要么在本机起一个协议翻译桥。补丁 C 增加第三条路——在 provider 插件内直接注册一个 REST provider。

## 补丁做什么

在 `node_modules/@deepseek-ai/dsh-web-search-deepseek/lib/index.js`（幂等，由 `scripts/apply-patches.mjs` 应用）中：

1. 新增 `AnySearchRestProvider`（provider id：`anysearch`）：
   - `search()` 对 `${baseURL}/search` 发 `POST { query }`，`Authorization: Bearer <key>`；
   - 把 `data.results[]` 归一化为 `{ url, title, snippet, publishedAt? }` 来源列表；
   - 复用同一设置段的 key 解析（credentials service / 环境变量 / 字面量 `apiKey`）。
2. 与 DeepSeek provider 一同注册，导出类便于测试。

## 可用性守卫（避免歧义）

`ctx.web` 的选择规则：显式配置 `searchProvider`（或环境变量 `DSH_WEB_SEARCH_PROVIDER`）→ 该 provider；否则唯一可用者胜出；多个可用者报 `WEB_PROVIDER_AMBIGUOUS`。

为避免新增 provider 后与 DeepSeek / 桥接端点冲突，`AnySearchRestProvider.available()` **只在 baseURL 主机名匹配 `anysearch` 时返回 true**：

| baseURL | available() |
| --- | --- |
| `https://api.anysearch.com/v1` | ✅ |
| `http://127.0.0.1:8798/v1`（本地协议桥） | ❌ |
| `https://api.deepseek.com/anthropic/v1` | ❌ |

因此：

- 只用 DeepSeek key、或本地桥接方案 → 行为与上游完全一致（anysearch provider 不可用，无歧义）；
- 只用 AnySearch key + anysearch baseURL → 自动选中，无需额外配置；
- DeepSeek key 与 AnySearch key **同时**存在且 baseURL 指向 anysearch → 需显式 `DSH_WEB_SEARCH_PROVIDER=anysearch`。

## 配置

### 1. 凭据

写入 `~/.dsh/.credentials.yaml`（推荐，与 `FRIDAY_API_KEY` 同格式）：

```yaml
ANYSEARCH_API_KEY: "as_sk_<your-key>"
```

或在启动环境中导出 `ANYSEARCH_API_KEY`。也可以在 settings 段写死字面量 `apiKey`（不推荐，见下）。

### 2. settings.yaml

复用 `web-search-deepseek` 设置段（UI 的 WebSearch 卡片即此段）：

```yaml
web-search-deepseek:
  apiKeyEnv: ANYSEARCH_API_KEY
  baseURL: https://api.anysearch.com/v1   # REST 根地址；补丁自动追加 /search
  apiVersion: 2023-06-01                  # 可选，REST 下不使用
  maxTokens: 4096                         # 可选
  maxUses: 5                              # 可选，每请求搜索上限
```

### 3. provider 选择

```bash
export DSH_WEB_SEARCH_PROVIDER=anysearch   # 显式选择（多数场景可省）
```

等价地，可在 `ctx.web` 服务的配置（settings）中设 `searchProvider: anysearch`。

## 验证

```bash
npm run patch:check     # 应看到 [patched] web-search:anysearch-rest-provider
```

随后在会话里任意触发一次 `web_search`（例如问一个需要实时信息的问题），结果应包含 `title` / `url` / `snippet` 的结构化来源；模型回答中会附带来源链接。

### 无代码冒烟测试（可选）

```bash
node --input-type=module -e "
const mod = await import('file://' + process.cwd() + '/node_modules/@deepseek-ai/dsh-web-search-deepseek/lib/index.js');
const p = new mod.AnySearchRestProvider(() => ({
  apiKey: process.env.ANYSEARCH_API_KEY,
  baseURL: 'https://api.anysearch.com/v1',
  model: 'anysearch', maxTokens: 4096, maxUses: 5,
}));
console.log('available:', p.available());
console.log(await p.search({ query: 'hello world' }));
"
```

## 备注

- AnySearch 计费/配额挂在 `ANYSEARCH_API_KEY` 对应账户，与 DeepSeek 无关。
- 想保留旧行为（DeepSeek 官方搜索或本地协议桥）不需要任何改动：把 baseURL 指回对应端点即可，`anysearch` provider 会自动变为不可用。
- 上游若更新 `dsh-web-search-deepseek` 导致锚点漂移，`apply-patches.mjs` 会打印 `anchor not found` 并恢复 `.bak`，不会破坏安装；届时按新文件更新补丁的 `edits` 即可。
