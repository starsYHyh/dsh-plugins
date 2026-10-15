# dsh-notify

会话事件的本机通知插件（桌面 GUI 用）：**回合完成**或**需要你确认/输入**时弹系统横幅，不必再盯着页面看。

> 安装方法见仓库根目录 [README](../../README.md#安装-dsh-notify)：把本目录拷到
> `~/.dsh/profiles/<profile>/plugins/`，再在 `cordis.patch.yml` 里加一段 `- insert:` 即可。

插件由两部分组成：

| 文件 | 运行位置 | 作用 |
|---|---|---|
| `lib/index.js` | Host 进程（Node） | 空实现。它的存在让这一行成为普通的 Loader row，Host 才会读取本包的 manifest 并把 `lib/client.js` 作为浏览器端 bundle 下发。 |
| `lib/client.js` | 页面（Electron 渲染进程） | 真正的逻辑：订阅会话状态投影，调用页面自己的 `Notification` API 弹系统通知。 |

## 触发条件

| 事件 | 通知 |
|---|---|
| 会话从「运行中」变为「空闲」 | 「回合已完成，可以回来查看了」 |
| 出现待处理交互（工具授权确认 / 需要你回答） | 「需要你批准工具调用：<工具名>」或「需要你的输入」 |
| 页面每次加载（每个标签会话一次） | 「通知已开启」——用来确认投递链路正常 |

细节：

- **只在你不看页面时打扰**：`document.hidden` 或窗口失焦才弹通知；你正看着页面时只更新内部状态，不弹横幅。
- **回合结束后等 1.5 秒再判断**：多轮 goal 在轮次之间会短暂空闲，这个 settle 窗口把它折叠成一条通知（期间又跑起来就不通知）。
- **子会话（subagent）默认静默**，避免子代理刷屏。
- 通知标题是会话显示名；点击横幅会聚焦应用窗口；同会话通知用 tag 覆盖，不堆叠。

## 调整行为（浏览器 localStorage）

在该应用的开发者工具 Console 里设置，改完立即生效（只影响渲染进程，重启页面后仍保留）：

| 键 | 默认 | 含义 |
|---|---|---|
| `dshNotify.enabled` | `1` | `0` 关闭全部通知（保留订阅） |
| `dshNotify.greet` | `1` | `0` 关闭页面加载时的「通知已开启」提示 |
| `dshNotify.silent` | `0` | `1` 静音（只弹横幅不响） |
| `dshNotify.always` | `0` | `1` 即使你正看着页面也弹通知 |
| `dshNotify.subagents` | `0` | `1` 子会话完成也通知 |
| `dshNotify.settleMs` | `1500` | 回合结束后的稳定判断窗口（0–10000 ms） |

例：`localStorage.setItem('dshNotify.silent','1')`。

## 自检

Console 里可用：

```js
__dshNotify.test()    // 立刻弹一条测试通知（绕过焦点判断）
__dshNotify.state()   // shapeOk / notifications / lastReason / 各会话 running / 待处理交互
```

离线的纯逻辑回归测试（模拟模块加载器、`uiSession` 投影与 Notification API）：

```sh
node test/harness.mjs
```

## 官方更新桌面端之后

插件装在 `~/.dsh/profiles/desktop/`，而应用更新只替换 `/Applications/DeepSeek Harness.app`，所以**安装位置、注册行、代码都不会被更新覆盖**：

- 每次启动的 `initProfile` 只在文件缺失时创建 profile 文件，不会重写 `cordis.patch.yml`；
- 兼容性闸门（`evaluatePluginCompatibility`）只看 `peerDependencies` 里 `@deepseek-ai/dsh*` 的范围，本包一个都没声明，因此不会因"版本不兼容"被自动禁用；
- 插件行加载失败只会让 Host 打警告（普通行不是 required 行），应用照常启动；页面侧失败会出现在插件列表页的诊断里。

需要复查的只有 DSH 的**内部客户端契约**（`uiSession.sessionStatus` 的形状、会话行的 `running`/`displayTitle`/`origin`/`parentId`、`window.__ModuleLoader__.load` 的 bundle 契约）。为此插件做了防御：形状不对时只打印一条明确警告并把 `shapeOk` 置为 `false`，既不静默失效也不会抛错影响页面。

更新后自检三步：

1. `__dshNotify.state()` → `shapeOk: true` 且 `running` 与界面一致；
2. 把窗口切到后台，`__dshNotify.test()`（macOS 不给前台应用弹横幅，必须切走再看）；
3. 若 `shapeOk: false`，说明 DSH 改了客户端 API，需要按新版适配 `lib/client.js`。**改完要重启应用才生效**——profile 的 HMR 配置是 `root: []`，不监听模块文件，只在重启重新合成时更新 bundle。

极端情况：启动致命失败时，弹窗里的「禁用第三方插件」会把 `cordis.patch.yml` 备份成 `cordis.patch.yml.bak-<时间戳>` 并停用第三方行。插件代码仍在，恢复时从备份里把那一段 `- insert:` 贴回 `cordis.patch.yml` 即可。

## 已知边界

- 通知由**页面**发出，所以窗口完全关闭后不会再通知（窗口在后台/最小化仍然有效）。
- 若系统层面拦截了通知，请到「系统设置 → 通知 → DeepSeek Harness」确认允许通知、且未处于专注模式。
- 只覆盖「回合完成」和「等待人工确认」；后台任务（jobs）单独完成不在其中。

## 卸载

1. 删除 `cordis.patch.yml` 末尾这段：

   ```yaml
   - insert:
       - id: dsh-notify
         name: ./plugins/dsh-notify/lib/index.js
   ```

2. 删除本目录（`<profile>/plugins/dsh-notify`）。
