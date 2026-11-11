# dsh-knowledge-base

dsh-knowledge-base 是 DeepSeek Harness 中可独立安装的个人知识库。它保存你关注的材料与思考，以问题连接笔记和讨论，借助 DSH 原生 Agent 共创，再由你手工沉淀成新的内容。支持 Markdown、附件和历史版本，资料保存在运行 DSH 的 Host 电脑上。

产品暂定名为 **dsh-knowledge-base**，当前已发布版本为 **0.1.0**，npm 包名为 `@lokinko/dsh-knowledge-base`。下文功能描述对应仓库当前开发状态，尚未发布的变更见 [Unreleased 更新日志](CHANGELOG.md#unreleased)。Git 发布标签与 npm 包使用相同版本号。

## 功能

### 笔记与编辑

- 保留文档、阅读、代码和日记分类，可按需新增分类和子分类，拖动调整顺序与层级；选择父分类时包含子分类笔记。
- 在“管理分类”中拖到行上沿/下沿可排序，拖到中央可移入，也可使用父分类选择框及上移/下移按钮。分类结构随资料库保存和迁移。
- 支持标签、置顶、搜索和网格／列表视图。
- CodeMirror 增量编辑、编辑／预览／分屏、Markdown 格式工具和行首 `/` 菜单，支持数学公式、代码高亮及任务列表。
- Ctrl+P 快速打开、Ctrl+Shift+P 命令面板、Ctrl+F 文档查找替换，保留撤销／重做与混合换行原文。
- 大文档预览使用本地 Worker 与可见区渲染；标题目录全量派生、支持折叠，文件目录懒加载并可拖动归类。
- 正文原样保存，不设固定字符数上限；预览渲染不会改写原文。
- 自动保存、本机草稿恢复、版本历史、快照、回收站与恢复。
- 导入 Markdown 文件，或将单篇笔记导出为 Markdown。
- 独立的阅读与编辑字体设置。

### 笔记附件

- 每篇笔记都可添加图片、PDF 及其他任意文件。
- 多选或拖入文件，按顺序逐个上传，保留原始字节。
- PNG、JPEG、WebP、GIF 显示缩略图；原图和 PDF 可在新标签页打开，文件可下载。
- 复制 Markdown 引用，或将引用附加到当前正文末尾。
- 附件列表支持分页。“移出列表”保留原文件，已有正文链接和历史版本引用仍可用。
- 上传中断后重新核对服务器列表；重试前可先确认哪些文件已经保存。

PDF 附件当前提供打开和下载功能，不提供文本提取或 OCR。

### AI 共写与检索

- 从笔记打开 DSH 原生会话，可继续关联对话或新建会话。
- 助手先识别当前会话绑定的笔记及其元信息，再按需检索、分块读取笔记。
- 按你的要求，助手可通过编辑工具修改笔记；修改受版本冲突检查保护。
- 笔记检索页只查询笔记，并可打开结果对应的原笔记。
- 相关时，助手可回顾当前资料库内授权的旧讨论，再给出自己的思考；弱相关时直接继续话题。首版使用有范围限制的词法候选检索。
- 「待整理」支持手工建立问题、跨笔记和讨论挑选原文来源、移除和排序，再按需打开 DSH 原生共创。
- 整理时机和观点合并由你决定；正式内容通过空白笔记手工录入。详见[讨论与按问题整理规格](docs/spec/discussions-and-topics.md)。

| 工具 | 用途 |
| --- | --- |
| `manage_notes`、`edit_note` | 管理笔记、历史版本与正文编辑 |
| `manage_note_categories` | 新增、改名、移动分类与读取树形顺序 |
| `search_notes` | 检索笔记并分块读取精确内容 |
| `search_note_discussions` | 在绑定的知识库会话中查找相关来源、精确读取或查询当前手工问题 |
| `manage_note_chat` | 查询或创建笔记与原生会话的绑定 |
| `manage_note_storage` | 检查和切换笔记资料目录 |
| `manage_note_attachments` | 管理本插件的笔记附件 |

共写使用当前 DSH 会话的模型配置。

## 运行要求

- DeepSeek Harness 运行时 `@deepseek-ai/dsh-base@0.2.2-rc.1`，与当前包声明的兼容版本一致。
- Host 使用 Node.js 22 或更高版本。
- DSH 环境须提供并启用 `@deepseek-ai/dsh-client-ui-conversation`，供笔记共写显示原生对话。

## 安装

**0.1.0 已发布到 npm**：[查看 npm 包](https://www.npmjs.com/package/@lokinko/dsh-knowledge-base/v/0.1.0)。发布包已包含预构建的 Host 与 Client 入口，通过 DSH 插件管理即可安装和启用。

使用旧的 `@lokinko/dsh-note` 时，请先按[独立笔记开发版升级说明](#从独立笔记开发版升级)停用旧插件；使用 `@local/todo-manager` 时，请先完成[旧组合开发版迁移](#从旧组合开发版迁移)。

### 使用 npm 安装

```sh
npm install -g @lokinko/dsh-knowledge-base
```

上面的命令安装 npm 上的最新版本。需要固定安装当前发布的 **0.1.0** 时，使用：

```sh
npm install -g @lokinko/dsh-knowledge-base@0.1.0
```

全局安装完成后，还需要通过 DSH 插件管理加载并启用插件，操作如下。

### 在 DSH 中安装并启用

1. 打开 DSH 的插件管理页面，选择从 npm 添加或安装插件。
2. 输入下面的完整包名并安装。
3. 安装完成后启用 **dsh-knowledge-base**，按 DSH 返回的应用结果刷新页面或完成后续操作，从侧边栏“笔记”进入。

```text
@lokinko/dsh-knowledge-base@0.1.0
```

### 让 DSH 助手安装

在提供插件管理工具的 DSH 会话中，可以直接发送：

```text
请通过插件管理安装并启用 @lokinko/dsh-knowledge-base@0.1.0。
```

对应的 `plugin_manager` 调用参数为：

```json
{"action":"install_bundle","target":"@lokinko/dsh-knowledge-base@0.1.0","enabled":true}
```

### 从源码安装

在运行 DSH 的 Host 电脑上克隆仓库并构建：

```sh
git clone https://github.com/lokinko/dsh-knowledge-base.git
cd dsh-knowledge-base
npm ci --ignore-scripts
npm run build
```

然后通过 DSH 的插件管理工具安装仓库的**绝对路径**。例如，仓库位于 `D:\code\dsh-knowledge-base` 时：

```json
{"action":"install_bundle","target":"D:\\code\\dsh-knowledge-base","enabled":true}
```

将示例路径替换为 Host 上实际的仓库路径。安装后启用插件并从侧边栏“笔记”进入；后续修改源码时，先重新构建，再通过 DSH 插件管理重新应用。

## 数据保存与目录切换

笔记、历史版本、会话绑定和附件由本插件独立保存。从笔记工作区打开“笔记存储位置”，填写 **运行 DSH 的 Host 上的绝对目录路径**；远程连接时，也以 Host 的文件系统为准。

所选目录的 `dsh-notebook` 子目录保存：

- 笔记内容、属性与历史版本。
- 笔记与 DSH 原生会话的绑定记录。
- 本插件的附件元信息及原始文件。

“检查路径”只验证目标。选择“保存并切换”后，先复制并校验资料，完成后才切换存储指向；原位置保留副本作为备份。笔记 ID、绑定记录和已有附件引用会保留。

DSH 原生会话日志仍由 DSH 管理，浏览器本机草稿仍留在当前浏览器。目录切换不自动将原生会话日志搬到另一套 DSH 安装。需要独立 Markdown 文件时，请使用单篇笔记导出。

### 从独立笔记开发版升级

本产品由独立笔记插件 `@lokinko/dsh-note` 更名而来，保留 `dsh_note` 存储域、原有笔记 API、附件地址、草稿前缀和会话关联。安装新版前先停用旧的独立笔记插件，避免两个入口同时操作同一份数据；已有独立笔记数据可直接沿用，无需再次执行组合版拆分迁移。

### 从旧组合开发版迁移

已使用 `@local/todo-manager` 的用户，应先停用旧组合版，再使用一次性迁移助手将笔记资料复制到独立存储，完成检查后启用 dsh-knowledge-base。迁移保留原位置副本，正文与历史版本原样保留；浏览器草稿继续使用原有笔记草稿前缀。

旧附件引用仅在预览渲染时映射到本插件的新地址，不为兼容链接重写已保存正文。迁移助手会复制保留引用所需的文件。迁移应按助手返回的结果完成，避免旧入口与迁移同时写入数据。

## 当前范围

**WebDAV 同步仍在规划中，不包含在 0.1.0 内。** 当前提供 Host 本地存储与目录迁移，不提供跨设备自动同步、端到端加密或一键离线 ZIP 导出。

## 开发与反馈

源码仓库与问题反馈：<https://github.com/lokinko/dsh-knowledge-base>。

在本包仓库根目录执行：

```sh
npm ci --ignore-scripts
npm run build
npm test
npm run check:release
```

构建生成 Host／Client 入口；测试覆盖单元、集成与 Markdown 渲染。`prepack` 会依次执行构建、测试和发布检查。安装发布包无需自行构建。

### 源码组织

```text
src/
  host/          # notes、categories、topics、discussions、search、storage、attachments、coauthor
  client/        # notes、editor、navigation、categories、topics、controls、markdown 等模块
                 # styles 和 labels 显式模块导入
scripts/
  build/         # Host / Client 构建、第三方样式与许可
  lib/           # 构建与测试共用的依赖边界检查
  build.mjs      # 统一构建入口
  test.mjs       # 自动发现并运行 tests/**/*.test.mjs
tests/
  host/          # 后端业务与文件系统测试
  client/        # 编辑协调、导航、渲染与宿主模块装配
  integration/   # 生产入口与跨层验证
  tooling/       # 模块边界、依赖方向、循环与闲置文件
  performance/   # 手动性能基准
  browser/       # Chromium 真实渲染、交互与截图
  prototype/     # 离线布局原型的模型与迁移验证
prototypes/      # 独立布局工坊与保留的 JSON 设计基线
docs/spec/       # 架构、行为契约、兼容边界与验收
```

从 [开发入口](docs/development.md) 定位修改位置与验证命令，再读 [spec 索引](docs/spec/README.md) 了解行为契约。开发时修改对应模块，不直接维护根目录的预构建入口；中间产物位于被忽略的 `.build/`。前端使用宿主 React，模块通过显式 import/export 和组件工厂传递依赖，无需源码文本拼接。`npm run check` 统一执行构建、Node 测试、发布检查与重复构建检查；源码依赖边界、循环与闲置文件也有自动检查。

提交 Git 时保留源码、测试、规格、锁文件、根目录预构建入口和第三方许可。依赖目录、临时构建、浏览器截图/报告、凭据与本地资料库由 `.gitignore` 排除。离线布局工坊的构建与使用见 [原型说明](prototypes/workbench/README.md) 和 [用户设计版说明](prototypes/workbench/ATOMIC-README.md)。

附加验证命令：

```sh
npm run check:reproducible
npm audit --omit=dev
npm pack --dry-run --ignore-scripts
npm run bench:client
npm run bench:workspace
```

UI 保留参考 [Solid Glass](https://deeplethe.github.io/solid-glass/) 的中性烟灰配色及 [Looseleaf](https://kevintngo.github.io/looseleaf/#/components) 的分区导航，并参考 [Quiet.md](https://github.com/s1dashu/quiet-md) 优化可见区、增量编辑、命令与目录交互，减少大面板模糊和多余层级。实现采用 Web 的 CodeMirror、IndexedDB 和本地 Worker；不等同于移植原生 GPUI 或承诺其原生基准。详见[工作区性能规格](docs/spec/performance-and-workbench.md)与[界面设计规格](docs/spec/ui-design.md)。浏览器验收使用隔离数据和实际插件构建，无需启动替代服务器：

```sh
npx playwright install chromium
npm run test:ui
```

Windows 可直接使用已安装的 Chrome，或通过 `DSH_TEST_CHROME` 指定路径。截图输出到 `.build/ui/`，浏览器测试依赖的 React 不进入插件发布包。

CI 覆盖 Ubuntu／Windows 和 Node 22／24，另有 Chromium 浏览器验收。`bench:client` 测量编辑协调与内存缓存算法成本；`bench:workspace` 使用真实浏览器测量输入、预览和异步草稿持久化。浏览器草稿采用 IndexedDB 合并事务并保留旧缓存兼容，恢复与失败处理契约见 [编辑器 spec](docs/spec/editor-and-coauthor.md)。构建和检查不会发布 npm，也不会自动更新当前 DSH 安装。

## 许可证

原始代码为 **UNLICENSED，保留所有权利**，尚未授予开源许可。公开源码或发布 npm 包本身不额外授予使用、修改或再分发原始代码的权利，详见 [LICENSE](LICENSE)。

第三方组件遵循各自许可证，许可文本见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 及相应依赖随附的许可证。
