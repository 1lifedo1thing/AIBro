# 安装与构建 / Install and build

当前发行目标是 **Apple Silicon Mac，macOS 14 及以上**。App 使用 SwiftUI / AppKit 与 WKWebView；macOS 26 可使用原生 Liquid Glass，较早系统采用兼容材质。Intel、Windows 和 Linux 安装包暂不提供。

公开安装包与当前开发源码可能不同。请从 [GitHub Releases](https://github.com/zihenghe04/AIBro/releases) 选择具体版本，查看系统要求、已知问题与附件；预发布版本不一定出现在 GitHub 的 `latest` 链接中。

## 下载与安装

1. 下载同一 Release 下的 DMG 和 `SHA256SUMS.txt`。
2. 核对安装包 SHA-256。下面的 `<version>` 是占位符，请替换成实际下载文件的版本；输出应与校验文件中**同名文件**的记录一致。
3. 正常退出旧版，把 DMG 中的 AI Bro 拖入“应用程序”。更新会替换应用包，不主动删除工作区；更新前保留一份备份。
4. 打开 App，在设置中配置兼容 API，或连接本机已安装的官方 Codex CLI。模型服务与可选同步服务需要分别配置。

```sh
shasum -a 256 'AI-Bro-<version>-macos-arm64-preview.dmg'
```

安装包内置独立 Python 与 PDF 运行时，使用 App 不需要安装 Node.js、Homebrew 或系统 Python。模型订阅、API 与 embedding 额度不包含在安装包中。

当前预览包采用 **ad-hoc 签名，尚未 Apple 公证**。首次打开时，macOS 可能要求在“系统设置 → 隐私与安全性”允许该应用。先核对下载来源和校验值；不要关闭系统整体安全保护。

Download a preview from [Releases](https://github.com/zihenghe04/AIBro/releases), verify its SHA-256 against the matching entry, quit the old app, and drag AI Bro into Applications. The packaged Python and PDF runtime needs no separate installation. Current previews are ad-hoc signed, not Apple-notarized; no Intel, Windows or Linux installer is supplied.

## 数据与更新

正式安装版默认将工作区保存在：

```text
~/Library/Application Support/ai-workstation
```

替换 `AI Bro.app` 不等于迁移、清理或删除这个目录。更新后正常重启 App；应用目前没有后台静默自动更新。不要同时操作多个共用正式数据目录的应用副本；原生版使用会话锁阻止第二个写入会话。

备份应在应用停止写入后进行，或使用一致性数据库备份并保留附件。完整目录可能包含模型凭据、登录会话与本机授权信息，不能直接作为公开反馈附件。详情见[桌面与数据](DESKTOP_APP.md)及[同步与备份](CLOUD_SYNC.md)。

## 从源码构建

构建环境：Apple Silicon Mac、Xcode 26 / macOS 26 SDK、Node.js 24、Python 3.12。部署目标为 macOS 14。下列命令安装开发依赖并执行项目检查；源码来自公共仓库。

```sh
git clone https://github.com/zihenghe04/AIBro.git
cd AIBro
npm ci
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements.txt
npm test
npm run test:native
npm run test:cloud
```

组件、编辑器或 Markdown 渲染源文件改变后，分别使用 `npm run build:ui`、`npm run build:editors`、`npm run build:document-markdown` 更新对应产物，并核对共享资源清单及第三方声明。依赖安装、测试或构建成功不能替代实际 Mac 窗口中的交互验收。

### 开发预览

`npm run build:native` 只编译原生可执行文件；`npm run start:native` 编译后启动。预览数据默认位于仓库相邻的 `.aibro-native-preview.noindex/workspace`，不使用正式安装版的数据目录。

**当前开发启动器的限制：** 它优先使用仓库内 `AI Bro.app/Contents/Resources/python/bin/python3`，找不到时使用 `/usr/bin/python3`；不会自动选择激活的 `.venv`，也不读取 `AI_WORKSTATION_PYTHON`。因此上面的虚拟环境安装不保证原生预览已经具备 PDF 等依赖。不要通过修改系统 Python 或手动拼装正式 App 绕过此问题；需要完整可分发运行时时，使用下面的发行构建。发行包使用其内置 Python，不受这一开发预览限制影响。

旧 `npm start`、`npm run app`、`npm run dist` 是 Electron 开发/旧打包入口，不能用来代替当前原生发行构建。

### 原生发行包

先审查并提交准备发行的源码和必需资源，确认跟踪文件没有未提交修改。发行入口同时要求运行时资源、原生源文件、`app/ui/` 与 `app/editor/` 的对应源码、构建补丁和许可证被 Git 跟踪；只提交编译后的 bundle 不够。检查通过后再执行：

```sh
npm run release:mac -- --output "$PWD/release/native-current"
```

`release/native-current` 必须是**尚不存在的新目录**；已有目录时脚本拒绝覆盖，下一次构建应另选输出名称。`--cache <directory>` 可复用校验通过的运行时下载。该命令在暂存目录构建，不替换正在运行或已安装的 App。

[scripts/release-native.js](../scripts/release-native.js) 使用 [release-runtime-lock.json](../scripts/release-runtime-lock.json) 中固定 URL 和 SHA-256 的独立 Python、PDF 依赖及对应源码，编译原生 App，校验架构、版本、签名和资源身份，再生成 ZIP、DMG、校验文件与发布清单。检查包含隔离后端启动、PDF 页面渲染、原件字节及运行时 HTTP 隔离；**它不是全功能原生 UI 验收**。

## 发布与源码一致性

公共仓库为 `zihenghe04/AIBro`。发布标签 `v<version>` 必须对应源码提交，并与根目录、`app/` 的 `package.json` 以及 `package-lock.json` 中的根包版本一致。原生包的版本来自这些元数据，不通过文档手动指定。

[发布工作流](../.github/workflows/release.yml) 在 macOS 26 安装锁定依赖、执行检查、构建和生成同提交源码归档；推送版本标签可创建 GitHub 预发布，手动工作流仅生成构建附件。它会保留已有的已发布版本，避免覆盖其附件。

`release-manifest.json` 记录源码提交、输入摘要、资源指纹、App 摘要与运行时信息；`SHA256SUMS.txt` 用于核对分发文件。发布前仍需检查真实原生主流程、待发布资源、许可和隐私，不能仅因构建为绿色就宣布新版本可用。

开发仓库的私有历史不能直接作为发布分支推送。应在公共仓库独立提交经过检查的源码，排除工作区、凭据、个人材料、私人截图、录制缓存、未跟踪实验和本机构建。Git 工作区干净不等于没有敏感内容，发布审查仍然必要。

## 依赖与许可

AI Bro 采用 [AGPL-3.0-only](../LICENSE)。发行包保留 CPython、PyMuPDF / MuPDF、certifi、Pillow 与前端依赖的许可和署名，并提供锁定的对应依赖源码及 `THIRD-PARTY-NOTICES.txt`。界面、编辑器和 Markdown 依赖的完整声明见[第三方说明](THIRD_PARTY.md)。重新分发或商业使用需继续遵守相应许可；用户的工作区内容不属于应用源码分发范围。

演示素材采用隔离示例数据，不应打包到用户工作区。源码、安装包和官网是分别发布的对象，更新其中一个不代表其他两者已经同步上线。
