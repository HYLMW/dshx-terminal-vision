# dshx

[![npm version](https://img.shields.io/npm/v/dshx-terminal.svg)](https://www.npmjs.com/package/dshx-terminal)
[![GitHub release](https://img.shields.io/github/v/release/Maydaytyh/dshx-terminal)](https://github.com/Maydaytyh/dshx-terminal/releases/latest)

`dshx` 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的原生交互式终端前端。它直接使用 Harness 的 Agent、工具、沙箱、权限确认、会话持久化和用户追问服务，不需要打开浏览器。

> [!IMPORTANT]
> 这是社区维护的非官方项目，与 DeepSeek 没有隶属或背书关系。

## 平台支持

`dshx` 不是 macOS 专用程序，CLI 本身使用跨平台 Node.js API，发布包也没有设置操作系统限制。

| 平台 | 状态 | 说明 |
| --- | --- | --- |
| macOS Apple Silicon | 已验证 | 当前主要开发与回归环境 |
| Linux x64 / ARM64 | 支持 | 推荐 Ubuntu、Debian 等 glibc 发行版；依赖包含对应 Linux 原生组件，正式 Linux CI 尚在补充 |
| Alpine / musl | 未完整验证 | 部分原生依赖可能需要额外构建工具 |
| Windows | 实验性 | 启动逻辑已做路径兼容，但尚未完整回归 |

## 安装

需要 Node.js 22.19.x 或 Node.js 24+，并确保 `corepack` 命令可用。`dshx` 会通过 Corepack 固定使用 pnpm 11.7.0 初始化自己的 Harness profile。

macOS 和 Linux 使用相同的 npm 安装方式。先检查运行环境：

```bash
node --version
corepack --version
```

如果系统没有 `corepack`，先安装并启用：

```bash
npm install -g corepack
corepack enable
```

通过 npm 安装（推荐）：

```bash
npm install -g dshx-terminal
dshx --version
```

也可以从 [GitHub Release](https://github.com/Maydaytyh/dshx-terminal/releases/latest) 下载、校验并安装：

```bash
curl -LO https://github.com/Maydaytyh/dshx-terminal/releases/download/v0.4.2/dshx-terminal-0.4.2.tgz
curl -LO https://github.com/Maydaytyh/dshx-terminal/releases/download/v0.4.2/dshx-terminal-0.4.2.tgz.sha256
shasum -a 256 -c dshx-terminal-0.4.2.tgz.sha256
npm install -g ./dshx-terminal-0.4.2.tgz
dshx --version
```

上面的校验命令适用于 macOS；Linux 通常使用：

```bash
sha256sum -c dshx-terminal-0.4.2.tgz.sha256
```

需要通过本机 7890 代理下载安装依赖时，先设置：

```bash
export HTTP_PROXY=http://127.0.0.1:7890
export HTTPS_PROXY=http://127.0.0.1:7890
export ALL_PROXY=socks5://127.0.0.1:7890
```

在远程 Linux 服务器上，`127.0.0.1:7890` 指服务器自身；如果代理运行在另一台机器，需要换成该代理对服务器可访问的地址。

设置 DeepSeek API Key：

```bash
export DEEPSEEK_API_KEY="your-api-key"
```

也可以写入 `~/.dsh/.credentials.yaml`：

```yaml
DEEPSEEK_API_KEY: "your-api-key"
```

首次真正运行 `dshx` 时会自动创建独立的 `~/.dsh/profiles/dshx` 配置。

## 使用

在项目目录启动：

```bash
cd /path/to/project
dshx
```

也可以带上第一条任务，完成后继续对话：

```bash
dshx "先阅读这个项目并告诉我如何运行"
```

一次性执行并退出：

```bash
dshx -p "列出项目里最大的三个文件"
```

恢复当前目录最近的会话：

```bash
dshx --continue
```

常用选项：

```text
-C, --cwd <dir>                 指定工作目录
-c, --continue                  恢复当前目录最近会话
-r, --resume <session-id>       恢复指定会话
-p, --print                     一次性运行
--permission-mode <mode>        read-only | workspace-write | danger-full-access
--tools <mode>                  native | code | both
--endpoint <name>               切换并保存当前命名端点
--dangerously-skip-permissions  完全访问且不再询问（谨慎使用）
```

交互中输入 `/help` 可查看 `/permission`、`/compact`、`/plan`、`/goal` 等 Harness 命令。按 `Ctrl-C` 可取消正在运行的任务；空闲时按 `Ctrl-C` 退出。

可以直接粘贴多行 prompt。粘贴内容中的换行会暂时显示为 `␤`，不会提前提交；检查内容后再按一次 Enter，`dshx` 会将它作为一个完整的多行 prompt 发送。

### 模型与状态

`dshx` 使用与 Harness 网页端相同的模型目录和会话统计投影。任务运行时，终端底部会显示一条约每秒更新一次的实时状态栏，包括当前模型、运行阶段或工具、耗时、TTFT、生成速度、输出 Token、Prompt Cache 命中率和上下文占用：

```text
● deepseek-official/DeepSeek-V4-Flash · 生成中 8.4s · TTFT 0.9s · ~38.6 tok/s · 输出 ~326 · 缓存 82% · 上下文 12%
```

流式阶段的输出 Token 和生成速度带 `~`，表示根据当前字符流与本地计时估算；提供方返回 usage 后会切换为精确 Token。缓存信息只能在模型提供 usage 后计算，在此之前显示 `—`。每轮完成后则使用 Harness 的精确累计投影，显示当前模型、轮次、模型与工具耗时、TTFT、生成速度、Token 用量、缓存命中率和上下文占用；统计会随会话一起持久化，不受历史分页或上下文压缩影响。

```text
deepseek-official/DeepSeek-V4-Flash  |  2 轮 · 4 步  |  模型 18.2s · 工具 1.1s  |  缓存命中 82%  |  输入 18.4K · 输出 1.2K  |  上下文 12%
```

实时状态栏只在交互式 TTY 中启用；`--print`、管道和重定向输出不会包含终端控制字符。

交互式选择模型与推理强度：

```text
/model
```

也可以直接指定路由：

```text
/model deepseek-official/deepseek-v4-pro high
```

查看完整状态、Token 与 Prompt Cache 明细：

```text
/status
/usage
```

其中输入 Token 与网页端口径一致，由未缓存输入、缓存读取和缓存写入三个互不重叠的部分组成；缓存命中率为缓存读取占全部输入的比例。上下文占用优先使用 Harness 对下一次请求的投影值，因此执行 `/compact` 后会立即更新。

### 多个 API 端点

可以在 Harness 的 `~/.dsh/settings.yaml` 中保存多个命名端点。`activeEndpoint` 是默认使用的端点；每个端点只保存 Base URL 和凭据引用，不保存 API Key 明文：

```yaml
dshx-terminal:
  activeEndpoint: official
  endpoints:
    official:
      description: DeepSeek 官方 API
      baseURL: https://api.deepseek.com
      apiKeyEnv: DEEPSEEK_API_KEY
    proxy:
      description: OpenAI 兼容代理
      baseURL: https://proxy.example.com/v1
      apiKeyEnv: PROXY_API_KEY
```

对应密钥继续放在 `~/.dsh/.credentials.yaml`：

```yaml
DEEPSEEK_API_KEY: "sk-official"
PROXY_API_KEY: "sk-proxy"
```

保护凭据文件：

```bash
chmod 600 ~/.dsh/.credentials.yaml
```

运行中交互选择端点，或者直接按名称切换：

```text
/endpoint
/endpoint proxy
```

也可以在启动时切换；该选择会写回 `activeEndpoint`，后续启动继续使用：

```bash
dshx --endpoint proxy
```

切换通过 Harness 设置服务热更新，下一次模型请求立即使用新的 `baseURL` 和 `apiKeyEnv`。运行中直接编辑当前端点定义也会自动同步。Base URL 会拼接 `/chat/completions`，因此代理服务使用 OpenAI 风格路径时通常应配置到 `/v1`；端点需要兼容 DeepSeek 的流式 Chat Completions 请求和响应。

默认权限模式是 `workspace-write`：Agent 可以读取文件，并在当前工作目录及受控临时目录写入；其他超出工作区的写操作会在终端里征求许可。

## 卸载

```bash
npm uninstall -g dshx-terminal
```

如果不再需要会话和独立 profile，可另外删除 `~/.dsh/profiles/dshx` 与 `~/.dsh/dshx-state.json`。

## 许可证

本项目使用 [MIT License](./LICENSE)。DeepSeek Harness 本身也采用 MIT License。
