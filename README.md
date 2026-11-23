# dsh-mac-computer-use

独立的 DeepSeek Harness macOS 插件。接口与 Codex 的 Computer Use 对齐，支持隔离网页任务和经授权的原生 App 操作；右上角显示实时预览。不替换官方 Computer Use。

## 能做什么

- **独立网页操作（默认）**：使用本机 Chrome/Chromium 新建临时资料和私有控制管道，不接管现有浏览器，也不读取其账户、Cookie 或扩展。可以导航、读取网页无障碍树、截图、点击和输入。网站要求登录或验证码时，停止并报告，不切换到你的浏览器。
- **实时预览**：首个操作触发右上角点击穿透的小窗，约每秒更新四帧；模型思考期间也会更新。回合结束或点击 DSH 的「停止」时自动关闭。停止不能撤回已派发的动作。
- **Codex 式原生操作（默认开启）**：通过名称、bundle ID、路径或 PID 选择 App，经用户本轮同意后按需启动；支持无障碍树、元素动作、点击、悬停、拖拽、滚动、按键、直接输入、保留并恢复系统剪贴板的粘贴，以及窗口截图。也可选择现有 Chrome 等浏览器以使用已登录会话。

## 安装

**已验证基线**：macOS 上的 DeepSeek Harness `0.2.2-rc.5` 桌面宿主、Node.js 22、Google Chrome。其它 DSH 版本未验证；原生模式还要求 macOS 14 或更高、官方 Computer Use helper 已安装且有 Accessibility 权限。原生实时预览独立检查录屏授权，没权限时可能只有静态帧。

1. 把克隆路径设为 `~/.dsh/plugins/dsh-mac-computer-use`，或在下列配置里使用对应的 `link:` 路径。安装 Xcode Command Line Tools 后，在克隆目录运行 `npm run build`。
2. 退出 DSH，备份 `~/.dsh/profiles/desktop/package.json`。**合并**下面的字段，不要覆盖其它依赖或已启用插件：

   ```json
   {
     "dependencies": { "dsh-mac-computer-use": "link:../../plugins/dsh-mac-computer-use" },
     "dsh": { "profile": { "bundles": ["dsh-mac-computer-use"] } }
   }
   ```

3. 如果桌面 profile 尚未创建此 link，可在确认目标路径不存在时运行：

   ```sh
   mkdir -p "$HOME/.dsh/profiles/desktop/node_modules"
   ln -s ../../../plugins/dsh-mac-computer-use "$HOME/.dsh/profiles/desktop/node_modules/dsh-mac-computer-use"
   ```

4. 重开 DSH。通过 PTC 检查是否有 `mac_computer_use`。卸载时只移除此 bundle、依赖和对应本地链接，再重启 DSH。

## 使用

例如对助手说：「用 `mac_computer_use` 独立后台打开 `https://www.douyin.com/hot`，列出公开热点，不要使用我的浏览器。」

- 浏览器：`browser_open`、`browser_status`、`browser_navigate`、`browser_back`、`browser_forward`、`browser_reload`、`browser_state`、`browser_screenshot`、`browser_observe`、`browser_click`、`browser_drag`、`browser_type`、`browser_key`、`browser_scroll`。`browser_observe` 在一次调用中返回无障碍树与截图，同一快照可用于元素或坐标操作。
- 原生：`capabilities`、`list_apps`、`find_apps`、`open_app`、`windows`、`state`、`observe`、`actions`、`invoke`、`perform`、`set_value`、`select_text`、`click`、`hover`、`type_text`、`press_key`、`paste`、`scroll`、`drag`、`screenshot`。优先使用 `observe` 与元素动作；坐标动作必须基于最新窗口观察。
- `stop_task` 可提前结束；正常完成时不必调用。使用最新的 `snapshotId` 和元素 ID；`dispatched` 表示已发送，不代表动作已成功。临时截图在回合结束后清理。

## 配置与限制

这些是 **DSH 宿主进程**的环境变量，而不是聊天或 PTC 脚本内的变量。修改后重启宿主。

| 配置 | 作用 |
| --- | --- |
| `DSH_MAC_CUA_CHROME` | 指定 Chrome/Chromium 可执行文件的绝对路径 |
| `DSH_MAC_CUA_HUD=0` | 关闭预览，保留后台操作 |
| `DSH_MAC_CUA_NATIVE=0` | 关闭默认启用的原生 App 操作，仅保留隔离浏览器 |

原生模式连接官方 helper 的私有协议，检查本机 helper 的 Developer ID 签名，但本地 IPC 不提供独立的加密对端认证。插件会在每轮首次选择 App 时单独询问，不读取官方插件的长期授权记录，也不替代 macOS 的 Accessibility 与 Screen Recording 授权。协议或签名变更时可能不可用。

浏览器会拒绝显式的本机、私网和链路本地地址，并拦截页面重定向、点击链接、框架和子资源对这些字面地址的请求。但它不是网络沙箱：DNS 重绑定、代理/VPN 路由和浏览器自身网络行为仍应在宿主防火墙或隔离网络中限制。不要把它用于访问不受信任网页同时可达敏感内网的环境。

与 Codex 当前实现仍有两项宿主差异：隔离浏览器目前是单标签，不提供 Codex 的 Browser/Chrome provider 与标签清单；App 授权按任务询问，不复用 Codex 设置中的长期允许列表。原生动作、组合观察、多 App 目标、自动启动、键鼠输入、剪贴板恢复、取消与结果复查语义已对齐。

## 开发与发布

```sh
npm run check
npm test
npm run build
```

测试只用本地浏览器 fixture 和模拟原生接口，不接触你的个人浏览器。发布只包含源代码，不包含本机构建的可执行文件、测试截图、浏览器资料、宿主配置或官方 helper。见 [第三方与兼容性说明](THIRD_PARTY.md)。`private: true` 防止误发到 npm。

安全问题请优先使用 GitHub 的私密漏洞报告，不要在公开 issue 中附带利用代码、凭据、个人数据或敏感内网信息。详见 [安全策略](SECURITY.md)。

## 许可证

本项目采用 [Apache License 2.0](LICENSE)。未随本项目分发的宿主与其它第三方软件遵循各自的许可。

## English summary

An independent Codex-style computer-use plugin for DeepSeek Harness. It combines a disposable headless Chrome session with user-approved native macOS app control, fresh accessibility/screenshot observations, semantic and pointer actions, keyboard input, clipboard-preserving paste, task cancellation, and a live preview. It does not modify the official Computer Use plugin.
