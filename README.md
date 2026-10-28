# dsh-plugins

我在 [DeepSeek Harness](https://github.com/omdsh-dev/dsh)（简称 dsh）桌面端用的一组本地插件。

这里的插件都是 **profile 级本地插件**：不发布到 npm，装在 `~/.dsh/profiles/<profile>/` 下，
靠 `cordis.patch.yml` 里的一行注册——因此**不会被应用更新覆盖**，也随时可以整目录删掉。

## 插件

| 插件 | 说明 | 位置 |
|---|---|---|
| **dsh-notify** | 会话事件的本机通知：回合完成、或需要你授权/回答时弹系统横幅；只在你**不看页面**时打扰。macOS 上审批改由**带「允许一次 / 拒绝」按钮的原生小窗**接管，不切回应用就能决定 | [`plugins/dsh-notify/`](plugins/dsh-notify/) |
| **dsh-visualize** | 对话内联可视化：Agent 写 HTML 片段 + 内容引用，Web 界面用沙箱 iframe 原位渲染；右上角菜单可复制图像 | [`plugins/dsh-visualize/`](plugins/dsh-visualize/) |
| dsh-browser 定制版 | Chrome 侧边栏助手，把浏览器标签页交给 dsh 来读和点；含 `@` 引用标签页、模型/推理等级菜单、消息时间与复制、右键「向 DeepSeek 提问」 | 独立 fork → [分支](https://github.com/starsYHyh/dsh-browser/tree/feat/desktop-ux-and-tab-mentions) · [Release](https://github.com/starsYHyh/dsh-browser/releases/tag/v0.1.4-dsh0.2.0-rc.2) |
| dsh-chat-manager | 会话历史管理：搜索归档、恢复会话、安全删除。**第三方**（作者 [WSL043](https://github.com/WSL043/dsh-chat-manager)，MIT），这里只做推荐 | `npm i dsh-chat-manager` |

> **dsh-browser 为什么不放进本仓库**：它是上游 [omdsh-dev/dsh-browser](https://github.com/omdsh-dev/dsh-browser)
> 的 fork（MIT）。保持 fork 形态才能持续 `git rebase` 跟进上游、并向上游提 PR；搬进本仓库会把这两件事都丢掉，
> 所以这里只保留入口链接。

> **dsh-visualize 的参考来源**：设计思路参考 OpenAI Codex 内置的 `visualize` skill（skill + 内联 HTML 画布契约）；
> 本仓库的实现、skill 文案与样式均为重新编写，未包含 Codex 的源码或资源。

## 安装 dsh-notify

前提：已安装 DeepSeek Harness 桌面端。本插件通过页面自己的 `Notification` API 弹通知
（所以通知显示为 DeepSeek Harness 的身份、且遵守系统专注模式），面向桌面 GUI。

macOS 上审批会额外走一个原生小窗：等待审批且 DSH 不在前台时，屏幕右上角弹出非激活的
「拒绝 / 允许一次」面板，点完直接把结果回给 Agent。它需要 Xcode Command Line Tools 里的
`clang`（首次使用时把 `lib/native/panel.m` 编译到 `~/.dsh/cache/dsh-notify/`，之后复用）；
没有 `clang` 或编译失败时自动回落应用内审批，不影响其他功能。

### 1. 放置插件

```bash
git clone https://github.com/starsYHyh/dsh-plugins.git
cp -R dsh-plugins/plugins/dsh-notify ~/.dsh/profiles/<profile>/plugins/
```

`<profile>` 通常是 `desktop`（桌面 App）或 `web`（`dsh web` / CLI）。

### 2. 注册到 profile

在 `~/.dsh/profiles/<profile>/cordis.patch.yml` 末尾追加：

```yaml
- insert:
    - id: dsh-notify
      name: ./plugins/dsh-notify/lib/index.js
```

`name` 是**相对该 patch 文件所在目录**的路径，所以插件目录必须和 `cordis.patch.yml` 同级放在 `plugins/` 下。

审批小窗的开关可选（不写就是默认值）：`approvalPopup`、`popupTimeoutMs`（默认 180 秒）、
`onlyWhenBackground`、`includeSubagents`、`frontmostBundleId`。含义见
[插件 README](plugins/dsh-notify/README.md#配置cordispatchyml)。

### 3. 重启 dsh

桌面 App 用 `Cmd+Q` **完全退出**再启动。

## 验证装好了

应用内置开发者工具（Console）里：

```js
__dshNotify.state()   // shapeOk 应为 true，running 与界面一致
__dshNotify.test()    // 立刻弹一条测试通知
```

> macOS 不给前台应用弹横幅：先把窗口切到别的应用，再回车执行 `__dshNotify.test()`。

单独预览审批小窗（会停留 30 秒，点按钮或关闭即结束）：

```bash
cd ~/.dsh/profiles/<profile>
node --input-type=module -e "const { prompt } = await import('./plugins/dsh-notify/lib/native/runner.js'); console.log(await prompt({ title: 'bash 请求提升权限', subtitle: 'dsh-dev', body: '这是一条测试原因', meta: 'DeepSeek Harness · 等待审批', allowLabel: '允许一次', denyLabel: '拒绝', timeoutMs: 30000 }))"
```

离线回归测试（纯逻辑，不需要 dsh 在跑）：

```bash
node plugins/dsh-notify/test/harness.mjs   # 浏览器半
node plugins/dsh-notify/test/host.mjs      # Host 半：配置、前台判断、队列、超时/中止
```

## 安装 dsh-visualize

对话内联可视化：Agent 把一张自包含的 HTML 片段写到文件，并在回复里给出内容引用，
Web 界面用沙箱 iframe 原位渲染；右上角 `⋯` 菜单可以「复制图像」。

### 1. 放置插件

```bash
git clone https://github.com/starsYHyh/dsh-plugins.git
cp -R dsh-plugins/plugins/dsh-visualize ~/.dsh/profiles/<profile>/plugins/
```

开发时也可以不拷贝，直接软链到仓库里的源码（改代码即改安装）：

```bash
ln -s "$PWD/dsh-plugins/plugins/dsh-visualize" ~/.dsh/profiles/<profile>/plugins/dsh-visualize
```

### 2. 安装 skill

```bash
mkdir -p ~/.dsh/skills/visualize
cp dsh-plugins/plugins/dsh-visualize/skill/SKILL.md ~/.dsh/skills/visualize/
```

### 3. 注册到 profile

在 `cordis.patch.yml` 末尾追加：

```yaml
- insert:
    - id: dsh-visualize
      name: ./plugins/dsh-visualize/lib/index.js
```

### 4. 重启 dsh

Host 半侧改动需要重启；只改 `lib/runtime.css` 时，新渲染的画布会直接生效。

## 使用 dsh-visualize

直接用自然语言要图即可，例如「把这组数据画成对比图」「解释一下这个流程」。
Agent 会加载 `visualize` skill，把片段写到工作区（通常是 `visualizations/<slug>.html`），
并在最终回复里单独输出一行内容引用；渲染后该行会变成画布。

画布能力：

- 沙箱 iframe（opaque origin + 严格 CSP），跟随界面明暗主题，高度随内容自适应
- 右上角 `⋯` → 复制图像（2x PNG；剪贴板不可用时自动下载 `visualization.png`）
- 片段可用 `--background`/`--foreground`/`--card`/`--primary` 等主题变量和 `.card`/`.btn`/`.table` 等工具类
- 内容列默认居中；主按钮使用宿主配对色，暗色主题不会白字白底

离线回归测试：

```bash
node plugins/dsh-visualize/test/contrast.test.mjs
node plugins/dsh-visualize/test/wrapper-contrast.test.mjs
```

无 GUI 的端到端 harness：

```bash
HARNESS_FRAGMENT=/absolute/path/to/fragment.html node plugins/dsh-visualize/test/harness.mjs
```

## 卸载

1. 删掉 `cordis.patch.yml` 里上面那段 `- insert:`；
2. 删掉 `~/.dsh/profiles/<profile>/plugins/<plugin>/`（`dsh-visualize` 另外可删 `~/.dsh/skills/visualize/`）；
3. 重启 dsh。

## 可调行为（dsh-notify）

设置存在页面 localStorage 里，改完**立即生效**（只影响渲染进程，重启页面后仍保留）：

| 键 | 默认 | 含义 |
|---|---|---|
| `dshNotify.enabled` | `1` | `0` 关闭全部通知（保留订阅） |
| `dshNotify.greet` | `1` | `0` 关闭启动时的「通知已开启」提示 |
| `dshNotify.silent` | `0` | `1` 静音（只弹横幅不响） |
| `dshNotify.always` | `0` | `1` 即使你正看着页面也弹通知 |
| `dshNotify.subagents` | `0` | `1` 子会话（subagent）完成也通知 |
| `dshNotify.settleMs` | `1500` | 回合结束后的稳定判断窗口（0–10000 ms） |

例：`localStorage.setItem('dshNotify.silent','1')`。

触发规则、边界情况和架构说明见 [plugins/dsh-notify/README.md](plugins/dsh-notify/README.md)。

## 许可

本仓库自有代码（`dsh-notify`、`dsh-visualize`）为 **MIT**，见 [LICENSE](LICENSE)。

`dsh-notify` 与 `dsh-visualize` 依赖 DeepSeek Harness 的**内部契约**（`uiSession` 会话投影、`webServer` 路由、`systemPrompt`、`window.__ModuleLoader__` 的 bundle 约定），dsh 大版本更新后可能需要适配。
插件对此有防御：形状不符时只打印一条明确的警告并把 `shapeOk` 置为 `false`，不会静默失效、也不会影响页面。
