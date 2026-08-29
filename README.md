# qq-electron

让腾讯 Linux QQ 使用 Arch Linux 系统 Electron 运行的兼容层及 AUR 打包文件。

本项目不包含或重新分发 QQ 本体。`PKGBUILD` 会从腾讯官方地址下载 Linux QQ，保留其中的 `resources/app`，再加入本仓库的兼容代码，并通过系统安装的 Electron 启动。

当前配置面向 Electron 40。若新版 Electron 仍与现有 QQ 兼容，只需在 `PKGBUILD` 中调整 `_electron`；QQ 升级所需的版本号、下载地址参数和校验值也集中保存在 `PKGBUILD` 中。

## 主要作用

- 使用 `main.js` 接管应用入口，适配系统 Electron，并继续加载 QQ 原始的 `app_launcher`。
- 重定向 QQ 的 preload，使不同窗口共用兼容入口并正确加载 `major.node`。
- 兼容 QQ 自带的 V8 code cache 与系统 Electron 的运行环境。
- 通过一个小型原生兼容库补充 QQ 所需、上游 Electron 未导出的模块注册符号。
- 固定到打包安装的 QQ 版本，阻止下载版本覆盖它，并禁用 QQ 的自动更新和热更新检查。

QQ 的版本更新应通过重新构建和升级 AUR 软件包完成。

## 文件说明

- `main.js`：系统 Electron 入口及主要兼容逻辑。
- `preload.js`：普通窗口的 preload 分发入口。
- `session-preload.js`：Session preload 的共用入口；打包时会为 QQ 需要的文件名创建硬链接。
- `code-cache.js`：`resourcesPath` 和 V8 code cache 兼容处理。
- `disable-updates.js`：阻止 QQ 热更新检查。
- `electron-compat.c`：原生模块注册符号兼容层。
- `PKGBUILD`：下载官方 QQ、组装文件并构建 Arch Linux 软件包。
- `qq-electron.sh`：软件包启动脚本。

## AUR 打包

提交到 AUR 时，`PKGBUILD` 和 `qq-electron.sh` 放在同一目录。`qq-electron.sh` 作为本地 source 由 `makepkg` 复制到 `${srcdir}`；其余兼容代码由 `PKGBUILD` 中的 GitHub source 获取。

## 风险提示

本仓库中的所有 JavaScript 代码均由 GPT-5.6 Sol 生成，没有任何人工编写或添加。代码可能存在尚未发现的问题，请自行审查并承担使用风险（use at your own risk）。

本项目是非官方兼容方案，与腾讯及 Electron 项目无关。
