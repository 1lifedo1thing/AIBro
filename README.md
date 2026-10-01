<p align="center"><img src="app/ai-bro-icon.png" width="80" height="80" alt="AI Bro" /></p>
<h1 align="center">AI Bro</h1>
<p align="center"><strong>把一次对话，变成可以继续的工作。</strong></p>
<p align="center">Mac 上的个人知识与任务工作区 · 本地优先 · 自选模型</p>
<p align="center">简体中文 · <a href="README.en.md">English</a></p>
<p align="center"><a href="https://github.com/zihenghe04/AIBro/releases">下载 Mac App</a> · <a href="https://zihenghe04.github.io/AIBro/">官网与演示</a> · <a href="CHANGELOG.md">更新日志</a> · <a href="https://github.com/zihenghe04/AIBro/issues">反馈问题</a></p>

AI Bro 把对话、原始资料、可编辑文档和下一步安排放在同一个项目里。读一份课件、整理一篇论文，或推进日常计划：带着来源向 AI 提问，核对它提出的修改，留下能继续编辑、引用和追问的成果。

![AI Bro 的项目与文档阅读区，示例工作区](launch/dist/assets/recordings/zh/06-project-reader.jpg)
<p align="center"><sub>现有 Mac App 演示录屏静帧，使用示例工作区；界面持续迭代。<a href="https://zihenghe04.github.io/AIBro/#film">观看演示</a></sub></p>

> **开发预览。** 当前交付重点是 Mac App。下文介绍当前源码的能力，正在验收的改进可能尚未进入公开安装包；下载版本、支持平台与已知问题以对应 [Release](https://github.com/zihenghe04/AIBro/releases) 说明为准。

## 从资料到下一步

| 你要做的事 | 在 AI Bro 中完成 |
| --- | --- |
| **学一门课** | 把课件、学习笔记和对话归入课程项目；查看 PDF 原页、沿引用核对内容，再将复习任务和课表放进日程。 |
| **推进研究** | 汇集论文、方法、实验与开放问题。用 Research Wiki 整理知识、关联来源，让后续提问继续使用已有资料。 |
| **写完一份文档** | 在可视编辑与 Markdown 源码间切换，处理标题、列表、表格、代码和公式；查看 AI 修改的差异，再决定采纳什么。 |
| **继续之前的讨论** | 打开项目中的原会话，补充文件或追问；需要改变方向时编辑并重发，或从某条消息建立分支，保留原内容。 |
| **把计划做下去** | 用任务、检查项、看板和排期组织下一步；在日程中查看截止日期、重复事件和导入的 ICS 课表，按需开启系统提醒。 |

### 一个项目，保留工作的来处和去处

项目集中管理**对话、资料、成果与任务**。资料保留原件，成果指向实际保存的文档；打开来源、阅读、修改后，还能回到刚才的工作。日常、课程与科研空间帮助分类，独立对话也可以用文件夹整理。

文档在可调宽度的阅读区中打开，支持标签和放大阅读。Markdown 提供阅读、可视编辑与源码模式，大纲、查找和保存留在文档旁边。本机项目目录需要单独授权，授权后可从文件树打开文件。

### 让修改看得清，也留得住

AI 的执行过程可以展开查看；审批、停止和重试有对应入口。支持的文档与文件修改提供差异审阅，保存后能继续编辑。草稿、历史版本与回收站帮助恢复工作；**运行显示完成，不等于每次都会自动生成一个文件**，具体成果取决于任务和模型返回结果。

模型与工作区分开配置：可使用兼容 API，或连接本机官方 Codex CLI 登录，按会话选择模型。Skills、项目计划与记忆用于复用流程和上下文。模型支持的工具、附件格式和推理选项因服务而异。

## 开始使用

**发行包面向 Apple Silicon Mac，macOS 14 及以上。** macOS 26 可使用原生 Liquid Glass，较早系统使用兼容材质。安装包包含 Python 与 PDF 运行时，使用 App 不需要安装开发工具。

1. 打开 [Releases](https://github.com/zihenghe04/AIBro/releases)，选择要安装的预览版本，下载 DMG 与校验文件。
2. 核对校验值，正常退出旧版，再把 AI Bro 拖入“应用程序”。更新前保留一份工作区备份。
3. 在设置中连接模型服务，配置 API 地址、Key 和模型，或使用本机官方 Codex CLI 登录。
4. 新建项目，加入一份资料并开始对话；在阅读区核对来源，把成果和任务留在该项目中。

可以从一个明确的小任务开始：

> “根据这份课件整理本章的核心概念，标注来源页码，保存成学习笔记，再列出三项复习任务。”

当前预览包采用 ad-hoc 签名，尚未经过 Apple 公证。首次打开的系统提示、校验与构建步骤见[安装指南](docs/DISTRIBUTION.md)。

## 数据留在哪里

工作区默认保存在 Mac 的 `~/Library/Application Support/ai-workstation`。项目、对话、笔记和受管附件在本地保存；阅读、编辑与任务管理不要求连接同步服务器。使用远程模型、搜索或其他联网工具时，完成该操作所需的内容会发送到相应服务。

- **模型凭据单独保存。** 当前原生实现使用本机加密文件，不写入工作区导出或云同步；密钥与密文同在本机用户目录，不能防御拥有该目录读取权限的进程。详见[凭据存储说明](docs/DESKTOP_APP.md#模型凭据与登录)。
- **同步由你开启。** 可部署自己的服务，通过 HTTPS 或 SSH 隧道推送、拉取支持的工作区内容。SSH 连接用于同步，不提供远端文件树、远程终端或远端 Agent。
- **同步账号与 SSH 账号不同。** SSH 负责连接主机；同步服务账号由服务部署者创建，用于确定资料归属。API Key、本机目录授权等设备配置不随工作区同步。
- **同步不是备份。** 同步会传播修改和删除；服务端可读取同步内容，当前不提供端到端加密。备份与恢复方法、冲突处理和容量限制见[自托管同步](docs/CLOUD_SYNC.md)。

## 当前边界

AI Bro 仍在开发预览阶段。长会话、大资料库和复杂文档的性能、完整键盘与 VoiceOver 路径仍在完善；不能把已有功能视为所有场景都已验证。可视编辑仅覆盖支持的 Markdown 结构，不支持的扩展语法保留到源码模式。当前打开的文档可跨可视和源码模式连续撤销；重新打开可恢复正文与草稿，不持久保留整个撤销栈。

当前没有 Windows / Linux 安装包，也不以多人实时协作或云端运行 Agent 为目标。本轮开发和验收集中在 Mac App；较早版本的平台和附件以[历史发布说明](https://github.com/zihenghe04/AIBro/releases)为准。发现问题时，请附上版本、复现步骤和已脱敏的截图，提交到 [Issues](https://github.com/zihenghe04/AIBro/issues)。

## 从源码运行

原生 App 使用 SwiftUI / AppKit，文档与对话工作区通过 WKWebView 承载，配合本机 Python 服务。开发需要 Apple Silicon Mac、Xcode 26 工具链、Node.js 24 和 Python 3.12。

```sh
git clone https://github.com/zihenghe04/AIBro.git
cd AIBro
npm ci
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements.txt
npm run start:native
```

源码预览默认使用仓库相邻的 `.aibro-native-preview.noindex/workspace`，与正式安装版的数据目录分开。当前预览启动器不会自动选择激活的 `.venv`，PDF 等依赖的运行环境限制见[开发预览](docs/DISTRIBUTION.md#开发预览)。测试和演示应使用隔离数据，避免放入私人资料，见[贡献指南](CONTRIBUTING.md)。修改组件、编辑器或 Markdown 阅读源码后，分别运行 `npm run build:ui`、`npm run build:editors` 或 `npm run build:document-markdown`。发行构建使用 `npm run release:mac`，详见[安装与构建](docs/DISTRIBUTION.md)。旧 Electron 与浏览器入口保留用于开发，不是当前产品交付目标。

| 文档 | 内容 |
| --- | --- |
| [更新日志](CHANGELOG.md) | 每版主要变化 |
| [安装与构建](docs/DISTRIBUTION.md) | 安装、签名、校验与发布 |
| [自托管同步](docs/CLOUD_SYNC.md) · [服务部署](cloud/README.md) | 账号、同步、冲突与备份 |
| [知识检索](docs/KNOWLEDGE_RETRIEVAL.md) | 本地索引、来源与可选语义检索 |
| [贡献指南](CONTRIBUTING.md) · [第三方说明](docs/THIRD_PARTY.md) | 开发、反馈、依赖与许可 |

AI Bro 采用 [AGPL-3.0-only](LICENSE) 许可。Halaska Kit、AICSS、Bencho、Milkdown、CodeMirror 及其他依赖保留各自许可与署名，详见第三方说明。用户的文件、笔记与凭据不属于应用源码分发范围。
