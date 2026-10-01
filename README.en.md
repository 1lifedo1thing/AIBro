<p align="center"><img src="app/ai-bro-icon.png" width="80" height="80" alt="AI Bro" /></p>
<h1 align="center">AI Bro</h1>
<p align="center"><strong>Turn a conversation into work you can continue.</strong></p>
<p align="center">A personal knowledge and task workspace for Mac · Local first · Your choice of model</p>
<p align="center"><a href="README.md">简体中文</a> · English</p>
<p align="center"><a href="https://github.com/zihenghe04/AIBro/releases">Download for Mac</a> · <a href="https://zihenghe04.github.io/AIBro/?lang=en">Website and demo</a> · <a href="CHANGELOG.md">Changelog</a> · <a href="https://github.com/zihenghe04/AIBro/issues">Report an issue</a></p>

AI Bro keeps conversations, source material, editable documents and next steps in the same project. Study a lecture, work through a paper or plan your week: ask with sources in context, review proposed changes, and keep results you can edit, reference and discuss again.

![AI Bro project tasks and timeline in an example English workspace](launch/dist/assets/recordings/tour-en.jpg)
<p align="center"><sub>A frame from an existing Mac app demonstration, using an example workspace. The interface continues to evolve. <a href="https://zihenghe04.github.io/AIBro/?lang=en#film">Watch the demo</a></sub></p>

> **Developer preview.** The Mac app is the current delivery focus. This page describes the current source; improvements under acceptance testing may not yet be in a public installer. See the relevant [release notes](https://github.com/zihenghe04/AIBro/releases) for the downloadable version, platform support and known issues.

## From source material to a next step

| What you are working on | How AI Bro helps |
| --- | --- |
| **A course** | Keep slides, study notes and chats in a course project. Read original PDF pages, follow citations, and put revision tasks and timetables in the agenda. |
| **Research** | Gather papers, methods, experiments and open questions. Organize knowledge and sources in Research Wiki so later questions can build on the material you already have. |
| **A document** | Switch between visual editing and Markdown source for headings, lists, tables, code and math. Review AI changes as a diff before deciding what to accept. |
| **An ongoing conversation** | Reopen the project's chat, add material and ask follow-up questions. Edit and resend a message or branch from it when you want another direction, retaining the original content. |
| **A plan to carry out** | Organize work with tasks, checklists, boards and scheduling. See deadlines, recurring events and imported ICS timetables in the agenda, with optional system reminders. |

### A project keeps the work together

Projects bring together **chats, sources, outputs and tasks**. Sources keep the originals; outputs link to saved documents. Open a source, read or edit it, then return to the work it came from. Daily, Courses and Research spaces provide organization, while standalone chats can be arranged in folders.

Documents open in a resizable reader with tabs and an expanded reading view. Markdown has reading, visual editing and source modes, with outline, search and save controls close by. Local project folders require separate authorization before their files can be opened through the tree.

### Inspect changes and keep the result

Expand an AI run to inspect its activity, respond to approvals, stop it or retry. Supported document and file changes can be reviewed as diffs and edited after saving. Drafts, saved versions and the trash help recover work. **A completed run does not always create a file**; the available output depends on the task and the model's response.

Model connections are separate from your workspace. Use a compatible API or local official Codex CLI sign-in, then select a model per chat. Skills, project plans and memory provide reusable workflows and context. Available tools, attachment formats and reasoning options depend on the provider.

## Get started

**Release installers target Apple Silicon Macs running macOS 14 or later.** Native Liquid Glass is available on macOS 26, with fallback materials on earlier systems. Python and PDF runtimes are bundled, so using the app does not require developer tools.

1. Open [Releases](https://github.com/zihenghe04/AIBro/releases), choose a preview, and download its DMG and checksum file.
2. Verify the checksum, quit the previous app normally, and drag AI Bro into Applications. Keep a workspace backup before updating.
3. Connect a model in Settings using an API URL, key and model, or local official Codex CLI sign-in.
4. Create a project, add one source and start a chat. Check the evidence in the reader, then keep the output and next steps in that project.

Start with a small, concrete task:

> “Use these slides to explain the chapter's key concepts, cite the source pages, save a study note, and suggest three revision tasks.”

Current preview packages are ad-hoc signed and are not Apple-notarized. See the [installation guide](docs/DISTRIBUTION.md) for first-launch prompts, checksums and build instructions.

## Where your data lives

The default workspace is `~/Library/Application Support/ai-workstation` on your Mac. Projects, chats, notes and managed attachments are saved locally. Reading, editing and task management do not require a sync server. When you use a remote model, search or another online tool, content needed for that operation is sent to the relevant service.

- **Model credentials are separate.** The current native implementation stores them in local encrypted files, outside workspace exports and cloud sync. The key and ciphertext share the same local user directory; this does not protect against processes that can read that directory. See the [credential storage notes](docs/DESKTOP_APP.md#模型凭据与登录).
- **Sync is optional.** Host your own service and push or pull supported workspace content over HTTPS or an SSH tunnel. SSH is for synchronization, not a remote file tree, terminal or agent.
- **Sync and SSH accounts serve different purposes.** SSH connects to the host. The sync account is created by the service operator and identifies the data owner. API keys, local folder permissions and other device settings stay on each device.
- **Sync is not a backup.** It propagates edits and deletions. The server can read synchronized content; end-to-end encryption is not provided. See [self-hosted sync](docs/CLOUD_SYNC.md) for backups, conflicts and size limits.

## Current boundaries

AI Bro is a developer preview. Performance with long chats, large libraries and complex documents, as well as complete keyboard and VoiceOver coverage, remains under development. Implemented features should not be read as verification of every case. Visual editing covers supported Markdown structures; unsupported extensions remain available in source mode. The open document supports continuous undo across visual and source modes. Reopening restores content and drafts, not the entire undo stack.

Windows and Linux installers are not available. Real-time team collaboration and cloud agent execution are outside the current scope. Current development and acceptance testing focus on the Mac app; see [historical releases](https://github.com/zihenghe04/AIBro/releases) for earlier versions and their available platforms and assets. Report problems in [Issues](https://github.com/zihenghe04/AIBro/issues) with the version, reproduction steps and redacted screenshots.

## Run from source

The native app uses SwiftUI / AppKit, with WKWebView for documents and conversations and a local Python service. Development requires an Apple Silicon Mac, the Xcode 26 toolchain, Node.js 24 and Python 3.12.

```sh
git clone https://github.com/zihenghe04/AIBro.git
cd AIBro
npm ci
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements.txt
npm run start:native
```

Source previews use `.aibro-native-preview.noindex/workspace` beside the repository, separate from the installed app's data directory. The current preview launcher does not automatically select the activated `.venv`; see [development preview](docs/DISTRIBUTION.md#开发预览) for the PDF runtime limitation. Use isolated data without personal material for tests and demonstrations; see [Contributing](CONTRIBUTING.md). After changing component, editor or Markdown reading source, run `npm run build:ui`, `npm run build:editors` or `npm run build:document-markdown`, respectively. Release packaging uses `npm run release:mac`; see [installation and building](docs/DISTRIBUTION.md). Legacy Electron and browser entry points remain development tools rather than current product targets.

| Documentation | Contents |
| --- | --- |
| [Changelog](CHANGELOG.md) | Main changes by release |
| [Installation and building](docs/DISTRIBUTION.md) | Installation, signing, checksums and release builds |
| [Self-hosted sync](docs/CLOUD_SYNC.md) · [Server deployment](cloud/README.md) | Accounts, synchronization, conflicts and backups |
| [Knowledge retrieval](docs/KNOWLEDGE_RETRIEVAL.md) | Local indexing, sources and optional semantic retrieval |
| [Contributing](CONTRIBUTING.md) · [Third-party notices](docs/THIRD_PARTY.md) | Development, feedback, dependencies and licenses |

AI Bro is licensed under [AGPL-3.0-only](LICENSE). Halaska Kit, AICSS, Bencho, Milkdown, CodeMirror and other dependencies retain their respective licenses and attribution; see the third-party notices. User files, notes and credentials are not part of the application source distribution.
