# 开发入口

本仓库是 DSH 插件，由 Host 与浏览器 Client 两个运行入口组成。先读本文定位修改位置；行为约束见 [spec 索引](spec/README.md)。

## 目录边界

| 目录或文件 | 用途 | 维护方式 |
| --- | --- | --- |
| `src/host/index.js` | Host 服务装配与生命周期 | 在这里连接业务服务，不把业务规则放进装配函数 |
| `src/host/*/schema.js` | 持久化与请求数据契约 | 需要字段定义时直接导入；不依赖 Store、HTTP 或文件系统 |
| `src/host/topics/references.js` | 笔记与讨论的引用格式、标识与去重 | Topic 和讨论检索共用，不互相导入 Store |
| `src/host/*/store.js` | 业务规则与队列 | 通过注入的表或服务访问数据 |
| `src/host/storage/note-storage.js` | 表代理、资料库路由、目录提交与锁 | 保留已有格式、提交点和故障恢复约束 |
| `src/client/index.js` | 宿主能力与组件工厂装配 | React 来自宿主，组件工厂在插件初始化时创建 |
| `src/client/notes/ui.js` | 笔记工作区、列表与导航协调 | 编辑器和历史弹窗各有独立工厂 |
| `src/client/notes/editor.js`、`history.js` | 单篇笔记编辑生命周期、版本历史弹窗 | 通过明确依赖接入请求、草稿、控件 |
| `src/client/notes/edit-session.js` | 草稿和服务端保存的编辑协调 | 不混入 DOM 或缓存介质实现 |
| `src/client/notes/draft-record.js` | 字段校验、比较与草稿记录协议 | 保持存储键、原文和记录格式兼容 |
| `src/client/notes/legacy-draft-cache.js`、`browser-draft-cache.js` | 兼容缓存、IndexedDB 与失败恢复 | 两者共享记录协议；降级缓存仍有实际用途 |
| `src/client/editor/`、`markdown/` | CodeMirror 原文编辑、解析、Worker 与预览 | 原始换行、撤销历史、定位必须一致 |
| `src/client/styles/`、`labels/` | 插件样式和翻译 | 修改对应模块，并通过聚合入口装配 |
| `scripts/build/` | 打包、第三方样式隔离与许可收集 | `client.mjs` 装配流程，`styles.mjs` 处理 CSS，`notices.mjs` 收集许可 |
| `scripts/lib/module-boundaries.mjs` | 测试和发布共用的依赖边界检查 | 同时检查 Client、Host 和内嵌 Worker |
| `tests/` | 单元、集成、浏览器及性能验证 | `.test.mjs` 自动发现；浏览器和基准独立运行 |
| `prototypes/` | 离线布局工坊与用户设计基线 | 独立于生产构建；保留用户设计 JSON |
| 根 `index.js`、`client.js`、`THIRD_PARTY_NOTICES.md` | 发布用生成产物 | 修改源码后构建，不手工修改逻辑 |
| `.build/` | 中间产物、报告、截图 | 已忽略，不提交 |

## 常见修改路径

| 要修改的能力 | 从哪里开始 | 主要验证 |
| --- | --- | --- |
| 笔记字段、历史或保存 | Host `notes/schema.js`、`notes/store.js`；Client `notes/draft-record.js`、`notes/editor.js` | notes-store、note-edits、note-edit-session、category-draft |
| 分类、排序、拖放 | Host `categories/`；Client `categories/`、`navigation/` | categories、category-storage、category-tree、directory-navigation |
| 问题与讨论引用 | Host `topics/`、`discussions/`；Client `topics/` | topics、discussions、topic-storage 与浏览器 topics 用例 |
| 草稿、离线与恢复 | Client `notes/draft-record.js`、两个 cache、edit-session | browser-draft-cache、note-edit-session、category-draft；浏览器 IndexedDB 用例 |
| Markdown、快捷键或目录定位 | Client `editor/`、`markdown/` | editor-source、editor-commands、markdown-*；浏览器 CRLF/撤销/目录用例 |
| 存储目录或附件 | Host `storage/`、`attachments/`；对应 Client UI | note-storage、attachment-storage、stage-rename、category-storage、topic-storage |
| 构建和模块拆分 | `scripts/build/`、`scripts/lib/` | tooling/module-boundaries、check:release、check:reproducible |

## 本地验证

首次准备依赖：

```bash
npm ci --ignore-scripts
```

完整的构建、自动测试、发布检查和重复构建检查使用同一入口，CI 也执行它：

```bash
npm run check
```

只跑自动发现的 Node 测试：

```bash
npm test
```

集成测试会读取根目录预构建入口；修改 Host 源码后，先构建或直接执行 `npm run check`。测试只使用隔离资料，不连接个人知识库。

涉及组件拆分、布局、编辑器或交互时，再执行：

```bash
npm run test:ui
```

Chromium 首次安装与性能基准见 [构建与验收](spec/build-and-validation.md)。浏览器夹具验证实际 Client 和 Host 业务链路，但不能代替真实 DSH 安装的人工验收。

## 整理代码时保留的契约

- npm exports、插件 ID、存储域、HTTP 路径和已有附件链接保持兼容。
- 旧草稿键、旧目录表格式、历史会话地址和附件软移除记录都承担恢复职责，不能按名字当作废代码删除。
- Store 的旧 schema 导出和 edit-session 的旧缓存/协议导出是兼容转发；新代码直接使用契约或缓存文件。
- UI、Host 和开发脚本不交叉导入；源码不形成静态依赖环；`src/` 不存放入口不可达的闲置文件。自动测试守住这些约束。
- UI 工厂只在插件初始化时创建组件类型，避免重新渲染时重建编辑器、丢失选区或撤销记录。
- 原型是独立设计工具；用户设计基线不是运行时配置。只有经过实现与验证的能力才写进当前行为规格。
