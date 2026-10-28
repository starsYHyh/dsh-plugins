# dsh-notify

会话事件的本机通知插件（桌面 GUI 用）：**回合完成**或**需要你确认/输入**时弹系统横幅，不必再盯着页面看；
在 macOS 上，等待审批时还会弹一个**带按钮的原生小窗**，可以直接点「允许一次 / 拒绝」——不用切回客户端页面。

> 安装方法见仓库根目录 [README](../../README.md#安装-dsh-notify)：把本目录拷到
> `~/.dsh/profiles/<profile>/plugins/`，再在 `cordis.patch.yml` 里加一段 `- insert:` 即可。

插件由三部分组成：

| 文件 | 运行位置 | 作用 |
|---|---|---|
| `lib/index.js` | Host 进程（Node） | 审批拦截：监听 `approval/request`，在 DSH 不在前台时弹原生审批小窗，把点击结果直接回给等待中的 Agent。 |
| `lib/client.js` | 页面（Electron 渲染进程） | 订阅会话状态投影，调用页面自己的 `Notification` API 弹系统通知。 |
| `lib/native/panel.m` | Host 进程按需编译 | 原生审批小窗（无边框、非激活、屏幕右上角）；`lib/native/runner.js` 负责编译缓存、传参、超时与中止。 |

## 触发条件

| 事件 | 通知 |
|---|---|
| 会话从「运行中」变为「空闲」 | 「回合已完成，可以回来查看了」 |
| 出现待处理交互（工具授权确认 / 需要你回答） | 「需要你批准工具调用：<工具名>」或「需要你的输入」 |
| 审批阻塞、且 DSH 不在最前台（macOS） | 右上角原生小窗：「拒绝 / 允许一次」，点完立即把结果回给 Agent |
| 页面每次加载（每个标签会话一次） | 「通知已开启」——用来确认投递链路正常 |

细节：

- **只在你不看页面时打扰**：`document.hidden` 或窗口失焦才弹通知；你正看着页面时只更新内部状态，不弹横幅。
  审批小窗同理：DSH 在前台时保持应用内审批面板，不额外弹窗（`onlyWhenBackground` 可关）。
- **审批小窗不切应用**：它是一个非激活的浮动面板，点按钮不等于激活 DSH；你的当前前台应用和输入焦点保持不变。
- **小窗给出的结果等价于应用内按钮**：「允许一次」= `allowed-once`，「拒绝」= `rejected`。
- **超时或关闭不代你决定**：`popupTimeoutMs`（默认 180 秒）到点、或点右上角关闭，会把请求**交还**给应用内审批
  面板（回落时会照常弹通知），不会静默拒绝。请求被 Agent 侧取消时小窗立即消失。
- **子会话（subagent）默认静默**，避免子代理刷屏；`includeSubagents` 可开启。
- **回合结束后等 1.5 秒再判断**：多轮 goal 在轮次之间会短暂空闲，这个 settle 窗口把它折叠成一条通知（期间又跑起来就不通知）。
- 通知标题是会话显示名；点击横幅会聚焦应用窗口；同会话通知用 tag 覆盖，不堆叠。
- 阻塞类通知（审批 / 等待输入）默认带 `requireInteraction`：Windows / Linux 上会常驻不自动消失。
  macOS 的通知时长由系统控制（系统设置里的横幅/提醒样式），网页通知无法改写。

## 为什么按钮不直接做在通知横幅里

不是偷懒，是客户端架构限制：插件只能从**页面**调用 Web `Notification` API，而桌面端（Electron 44）把网页通知
映射成原生通知时只保留 title/body/tag/icon/silent/requireInteraction，**`actions` 被直接丢弃**，也不会派发按钮
点击事件；带按钮的只有 Electron 主进程 `Notification`，而插件跑在宿主 Node 子进程里，拿不到主进程 API。
所以「横幅里点允许/拒绝」在当前桌面端壳下做不到（除非改应用本体，那会被版本更新覆盖）。

本插件的做法：审批时由 Host 半接管这条请求，弹一个长得像通知卡片、但由 AppKit 绘制的原生小窗——效果就是
「不切回客户端也能点许可」，而且它在屏幕上停留多久由插件决定。

## 审批小窗的平台要求（macOS）

- 仅 macOS。其他平台自动跳过，审批仍走应用内面板 + 通知横幅。
- 需要 Xcode Command Line Tools 里的 `clang`（`xcode-select --install`）。首次审批时把 `panel.m` 编译到
  `~/.dsh/cache/dsh-notify/panel-<hash>`，之后复用；源码变化会自动重编译。
- 编译或启动失败时：只打一条警告（`[dsh-notify] ...`），审批自动回落应用内面板，不会丢请求。
- 文案跟随**系统语言**（中文 / 英文）；工作目录名作为副标题，正文是 Agent 给出的原因（过长会截断）。

## 配置（`cordis.patch.yml`）

Host 半的开关走 Loader 配置；改完需要重启应用：

```yaml
- insert:
    - id: dsh-notify
      name: dsh-notify
      config:
        approvalPopup: true        # 是否允许用原生小窗接管审批（仅 macOS 生效）
        popupTimeoutMs: 180000     # 小窗自动关闭时间，10000–3600000 ms
        onlyWhenBackground: true   # 仅当 DSH 不是最前台应用时弹窗
        includeSubagents: false    # 子会话审批也弹窗
        frontmostBundleId: com.deepseek.dsh  # 视为「正在看 DSH」的应用标识
```

| 键 | 默认 | 含义 |
|---|---|---|
| `approvalPopup` | `true` | 关掉后审批完全回到应用内面板 |
| `popupTimeoutMs` | `180000` | 小窗停留时长；超时回落应用内审批 |
| `onlyWhenBackground` | `true` | 你正在看 DSH 时不弹窗，避免与面板重复 |
| `includeSubagents` | `false` | 子会话审批是否也弹窗 |
| `frontmostBundleId` | `com.deepseek.dsh` | 判断「你在看 DSH」的应用 bundle id（一般不用改） |

## 调整行为（浏览器 localStorage）

在该应用的开发者工具 Console 里设置，改完立即生效（只影响渲染进程，重启页面后仍保留）：

| 键 | 默认 | 含义 |
|---|---|---|
| `dshNotify.enabled` | `1` | `0` 关闭全部通知（保留订阅） |
| `dshNotify.greet` | `1` | `0` 关闭页面加载时的「通知已开启」提示 |
| `dshNotify.silent` | `0` | `1` 静音（只弹横幅不响） |
| `dshNotify.always` | `0` | `1` 即使你正看着页面也弹通知 |
| `dshNotify.subagents` | `0` | `1` 子会话完成也通知 |
| `dshNotify.longLived` | `1` | `0` 让审批/等待输入的通知也自动消失（仅对支持该能力的平台有效） |
| `dshNotify.settleMs` | `1500` | 回合结束后的稳定判断窗口（0–10000 ms） |

例：`localStorage.setItem('dshNotify.silent','1')`。

## 自检

Console 里可用：

```js
__dshNotify.test()    // 立刻弹一条测试通知（绕过焦点判断）
__dshNotify.state()   // shapeOk / notifications / lastReason / 各会话 running / 待处理交互 / settings
```

单独预览审批小窗（不需要 Agent 真的触发审批；会停留 30 秒，点按钮或关闭即结束）：

```bash
cd ~/.dsh/profiles/desktop
node --input-type=module -e "const { prompt } = await import('./plugins/dsh-notify/lib/native/runner.js'); console.log(await prompt({ title: 'bash 请求提升权限', subtitle: 'dsh-dev', body: 'escalate sandbox to danger-full-access: 这是一条测试原因', meta: 'DeepSeek Harness · 等待审批', allowLabel: '允许一次', denyLabel: '拒绝', timeoutMs: 30000 }))"
```

端到端验证（真机）：

1. 把 DSH 窗口切到后台（例如点一下 Chrome），让 Agent 执行一个需要提升权限的操作；
2. 右上角应出现审批小窗，当前前台应用**不会**被切走；点「允许一次」后 Agent 的工具应继续执行；
3. 保持 DSH 在前台再触发一次：应只有应用内审批面板，没有小窗；
4. 不点任何按钮等超时（可把 `popupTimeoutMs` 调成 10000 验证）：小窗消失后应用内面板出现、通知照常。

离线的纯逻辑回归测试（模拟模块加载器、`uiSession` 投影、Notification API、Host waterfall）：

```sh
node test/harness.mjs   # 浏览器半
node test/host.mjs      # Host 半（配置、前台判断、队列、超时/中止）
```

## 官方更新桌面端之后

插件装在 `~/.dsh/profiles/<profile>/`，而应用更新只替换 `/Applications/DeepSeek Harness.app`，所以**安装位置、注册行、代码都不会被更新覆盖**：

- 每次启动的 `initProfile` 只在文件缺失时创建 profile 文件，不会重写 `cordis.patch.yml`；
- 兼容性闸门（`evaluatePluginCompatibility`）只看 `peerDependencies` 里 `@deepseek-ai/dsh*` 的范围，本包一个都没声明，因此不会因"版本不兼容"被自动禁用；
- 插件行加载失败只会让 Host 打警告（普通行不是 required 行），应用照常启动；页面侧失败会出现在插件列表页的诊断里。

需要复查的只有 DSH 的**内部契约**（`uiSession.sessionStatus` 的形状、会话行的 `running`/`displayTitle`/`origin`/`parentId`、
`window.__ModuleLoader__.load` 的 bundle 契约、以及 Host 的 `approval/request` waterfall 形状）。为此插件做了防御：
形状不对时只打印一条明确警告并把诊断置为 `false`/回落应用内审批，既不静默失效也不会抛错影响页面。

更新后自检三步：

1. `__dshNotify.state()` → `shapeOk: true` 且 `running` 与界面一致；
2. 把窗口切到后台，`__dshNotify.test()`（macOS 不给前台应用弹横幅，必须切走再看）；
3. 触发一次需要审批的操作，确认小窗仍能出现并在点击后回传结果；若失败，Host 日志里会有一条带
   `[dsh-notify]` 的警告，按新版的 `approval/request` / `approvalOutcome` 形状适配 `lib/index.js`。

**改完 Host 或页面代码都要重启应用才生效**——profile 的 HMR 配置是 `root: []`，不监听模块文件，只在重启重新合成时更新 bundle。

极端情况：启动致命失败时，弹窗里的「禁用第三方插件」会把 `cordis.patch.yml` 备份成 `cordis.patch.yml.bak-<时间戳>` 并停用第三方行。插件代码仍在，恢复时从备份里把那一段 `- insert:` 贴回 `cordis.patch.yml` 即可。

## 已知边界

- 通知由**页面**发出，所以窗口完全关闭后不会再收到回合完成通知；审批小窗由 **Host** 发出，窗口关掉也能弹（只要 Host 还在跑）。
- 若系统层面拦截了通知，请到「系统设置 → 通知 → DeepSeek Harness」确认允许通知、且未处于专注模式。
  审批小窗是普通原生窗口，不受专注模式限制。
- macOS 的通知横幅时长由系统控制，插件无法延长；能延长的是审批小窗（`popupTimeoutMs`）。
- 只覆盖「回合完成」和「等待人工确认」；后台任务（jobs）单独完成不在其中。
- 审批小窗只覆盖允许/拒绝两种一次性决策；需要你打字回答的问题仍走应用内面板。

## 卸载

1. 删除 `cordis.patch.yml` 末尾这段：

   ```yaml
   - insert:
       - id: dsh-notify
         name: ./plugins/dsh-notify/lib/index.js
   ```

2. 删除本目录（`<profile>/plugins/dsh-notify`）与编译缓存 `~/.dsh/cache/dsh-notify/`。
