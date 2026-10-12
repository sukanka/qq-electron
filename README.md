# qq-electron

让腾讯 Linux QQ 使用 Arch Linux 系统 Electron 运行的兼容层及 AUR 打包文件。

本项目不包含或重新分发 QQ 本体。`PKGBUILD` 会从腾讯官方地址下载 Linux QQ，保留其中的 `resources/app`，再加入本仓库的兼容代码，并通过系统安装的 Electron 启动。

当前配置面向 Electron 40。若新版 Electron 仍与现有 QQ 兼容，只需在 `PKGBUILD` 中调整 `_electron`；QQ 升级所需的版本号、下载地址参数和校验值集中保存在 `PKGBUILD` 中。构建脚本会从官方 QQ 可执行文件中自动定位并验证当前 ASAR 解密密钥。

## 主要作用

- 使用 `main.js` 接管应用入口，适配系统 Electron，并继续加载 QQ 原始的 `app_launcher`。
- 构建时解密 QQ 的 `application.asar`，再封装为系统 Electron 可读取的标准 ASAR。
- 重定向 QQ 的 preload，使不同窗口共用兼容入口并正确加载 `major.node`。
- 补齐辅助窗口继承普通 preload 时缺失的 `proxyInvoke`，复用 QQ 原有 IPC 完成窗口操作。
- 兼容 QQ 自带的 V8 code cache 与系统 Electron 的运行环境。
- 通过一个小型原生兼容库补充 QQ 所需、上游 Electron 未导出的模块注册符号。
- 通过进程内 D-Bus 调用桌面 OpenURI portal 打开外部链接，避免 QQ 原生模块在启动 `xdg-open` 的 fork 回调中崩溃。
- 点击 Linux 不支持的小程序卡片时，用默认浏览器打开卡片中的网页地址。
- 固定到打包安装的 QQ 版本，阻止下载版本覆盖它，并禁用 QQ 的自动更新和热更新检查。

QQ 的版本更新应通过重新构建和升级 AUR 软件包完成。

## 文件说明

- `main.js`：系统 Electron 入口及主要兼容逻辑。
- `preload.js`：普通窗口的 preload 分发入口。
- `session-preload.js`：Session preload 的共用入口；打包时会为 QQ 需要的文件名创建硬链接。
- `renderer-preload.js`：加载 QQ 原始 preload，并补充 renderer 字节码加载入口。
- `window-proxy.js`：补充辅助窗口的 `proxyInvoke`；已有 QQ 原生桥接时保留它。
- `renderer-modules.js`：观察 QQ renderer 模块加载，供兼容补丁共用。
- `miniapp-browser.js`：将不支持的小程序卡片点击转为浏览器打开。
- `code-cache.js`：`resourcesPath` 和 V8 code cache 兼容处理。
- `disable-updates.js`：阻止 QQ 热更新检查。
- `scripts/decrypt-application.js`：在构建阶段解密并重新封装 `application.asar`。
- `electron-compat.c`：原生模块注册符号兼容层。
- `portal-shell.js`：将主进程和 preload 的 `shell.openExternal()` 接入桌面 portal。
- `portal-open-uri.c`：使用 Node-API 和 GIO 在进程内发送 portal 请求，异步等待打开结果。
- `PKGBUILD`：下载官方 QQ、组装文件并构建 Arch Linux 软件包。
- `qq-electron.sh`：软件包启动脚本。

## AUR 打包

提交到 AUR 时，`PKGBUILD` 和 `qq-electron.sh` 放在同一目录。`qq-electron.sh` 作为本地 source 由 `makepkg` 复制到 `${srcdir}`；其余兼容代码由 `PKGBUILD` 中的 GitHub source 获取。

## 外部链接

打开外部链接需要运行中的用户会话 D-Bus、`xdg-desktop-portal` 以及支持 OpenURI 的桌面后端。桌面未提供相应后端时，可安装 `xdg-desktop-portal-gtk` 并按桌面配置启用。

兼容层保留 `shell.openExternal()` 的 Promise 接口，等待 portal 的 `Response` 后完成；取消、打开失败、服务不可用或超时会拒绝 Promise，不再退回 `xdg-open`。请求不创建辅助进程，也不关闭 Chromium 的 FD 所有权检查。这个改动仅覆盖 `openExternal()`，QQ 其他启动子进程的操作仍可能受到原生 fork 兼容问题影响。

当前请求不附带父窗口标识或 Wayland activation token，浏览器的窗口激活行为由桌面决定。

小程序卡片默认使用与右键“用浏览器打开”相同的卡片地址字段（`qqdocurl`、`url`、`jumpUrl`），选取可用的 HTTP/HTTPS 地址。腾讯文档保留原有桌面打开方式；没有可用网页地址的卡片仍由 QQ 处理。

## 验证

JavaScript 测试使用 `node --test tests/*.test.js`。`bash tests/portal-integration.sh` 会编译原生模块，并在隔离的 D-Bus 会话中验证 portal 请求及不执行 fork 的约束，不会打开真实浏览器；需要 C 编译器、Node.js 开发头文件、GIO、D-Bus、Python 和 PyGObject，安装 Electron 40 时也会验证其 Node 运行模式和真实主进程中的 `shell.openExternal()` 接入。

## 风险提示

本仓库中的 JavaScript 兼容代码由 AI 生成，没有任何人工编写或添加。代码可能存在尚未发现的问题，请自行审查并承担使用风险（use at your own risk）。

为兼容腾讯 Electron 独有的 `runInMainContext()`，QQ 窗口会关闭 Electron 的 context isolation。页面代码与 preload 因而共享同一 JavaScript 上下文，请仅运行可信的官方 QQ 资源。

本项目是非官方兼容方案，与腾讯及 Electron 项目无关。
