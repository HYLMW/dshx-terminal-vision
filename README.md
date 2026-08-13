# dshx

`dshx` 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的原生交互式终端前端。它直接使用 Harness 的 Agent、工具、沙箱、权限确认、会话持久化和用户追问服务，不需要打开浏览器。

> [!IMPORTANT]
> 这是社区维护的非官方项目，与 DeepSeek 没有隶属或背书关系。

目前已在 macOS Apple Silicon 上验证。

## 安装

需要 Node.js 22.19.x 或 Node.js 24+，并确保 `corepack` 命令可用。`dshx` 会通过 Corepack 固定使用 pnpm 11.7.0 初始化自己的 Harness profile。

从 [GitHub Release](https://github.com/Maydaytyh/dshx-terminal/releases/tag/v0.1.3) 下载并安装：

```bash
curl -LO https://github.com/Maydaytyh/dshx-terminal/releases/download/v0.1.3/dshx-terminal-0.1.3.tgz
curl -LO https://github.com/Maydaytyh/dshx-terminal/releases/download/v0.1.3/dshx-terminal-0.1.3.tgz.sha256
shasum -a 256 -c dshx-terminal-0.1.3.tgz.sha256
npm install -g ./dshx-terminal-0.1.3.tgz
dshx --version
```

需要通过本机 7890 代理下载安装依赖时，先设置：

```bash
export HTTP_PROXY=http://127.0.0.1:7890
export HTTPS_PROXY=http://127.0.0.1:7890
export ALL_PROXY=socks5://127.0.0.1:7890
```

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
--dangerously-skip-permissions  完全访问且不再询问（谨慎使用）
```

交互中输入 `/help` 可查看 `/permission`、`/compact`、`/plan`、`/goal` 等 Harness 命令。按 `Ctrl-C` 可取消正在运行的任务；空闲时按 `Ctrl-C` 退出。

默认权限模式是 `workspace-write`：Agent 可以读取文件，并在当前工作目录及受控临时目录写入；其他超出工作区的写操作会在终端里征求许可。

## 卸载

```bash
npm uninstall -g dshx-terminal
```

如果不再需要会话和独立 profile，可另外删除 `~/.dsh/profiles/dshx` 与 `~/.dsh/dshx-state.json`。

## 许可证

本项目使用 [MIT License](./LICENSE)。DeepSeek Harness 本身也采用 MIT License。
