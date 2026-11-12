# 构建与验收规格

## npm 发布契约

包名 `@lokinko/dsh-knowledge-base`；根 `index.js` 为预构建 Host ESM，`client.js` 为预构建浏览器 IIFE。`exports`、`files`、Cordis patch、locale 与 icon 由 [package.json](../../package.json) 指定。用户安装发布包无需构建，开发者不能只改源码而遗漏重新生成入口。

`prepack` 顺序执行构建、测试、发布检查。版本号和 Git 标签在正式发布时同步；本轮整理保留 0.1.0，变更记录列于 Unreleased。运行检查、打包预览不等于发布或更新当前 DSH 已安装插件。

## 构建步骤

```sh
npm ci --ignore-scripts
npm run build
npm test
npm run check:release
npm run check:reproducible
npm audit --omit=dev
npm pack --dry-run --ignore-scripts
```

`npm run check` 统一执行构建、Node 测试、发布检查与重复构建检查，CI 复用同一命令。浏览器验收、生产依赖审计与打包预览保持独立入口。

[scripts/build.mjs](../../scripts/build.mjs) 依次调用 Host 和 Client 构建：

- [Host 构建](../../scripts/build/host.mjs)：入口 `src/host/index.js`，目标 Node 22，打包本仓库逻辑，仅 Zod 与 Node 内置模块保持外部依赖。
- [Client 构建](../../scripts/build/client.mjs)：入口 `src/client/index.js`，目标 Chrome 110，打包为单 IIFE。CSS 作为文本显式导入，JSON 文案由模块合成；不再拼接/重写生成源码区域。
- Client 构建同时生成并内嵌 Markdown Worker IIFE，合并其许可和依赖图；运行时不下载远端解析器。CodeMirror 为构建依赖，不作为 Host 运行依赖。
- [样式构建](../../scripts/build/styles.mjs) 将 KaTeX 字体嵌入为 data URL，限制 Bootstrap CSS 与动画名称的作用域；[许可收集](../../scripts/build/notices.mjs) 根据 Client/Worker 的实际依赖图及 CSS 依赖生成第三方许可。Client 构建入口只装配这些步骤，无未解析浏览器 import。
- 构建 metadata 和临时 CSS 位于被 Git 忽略的 `.build/`；源码与脚本不混入发布运行依赖图。
- [发布检查](../../scripts/check-release.mjs) 验证入口、身份、两端依赖边界、资源、规格及私有路径/凭据；[重复构建检查](../../scripts/check-reproducible.mjs) 校验相同输入下三份正式产物逐字节相同。

## 自动测试

[scripts/test.mjs](../../scripts/test.mjs) 自动发现 `tests/` 下 `*.test.mjs`，使用 Node 内置测试运行器；性能基准以 `.bench.mjs` 区分，不设置易受机器负载影响的耗时断言。

| 分类 | 覆盖 |
| --- | --- |
| `tests/host/` | 笔记字段、历史、字面编辑、检索快照、目录切换、进程锁、附件与会话 |
| `tests/client/` | 草稿、恢复、并发/冲突、导航、几何、Markdown 和 DSH 模块装配 |
| `tests/integration/` | 源码 Host 独立域；预构建入口大正文；HTTP/工具与编辑器保存链路 |
| `tests/tooling/` | 源码依赖边界、循环、入口不可达文件；域定义只加载数据契约 |
| `tests/performance/` | 同步缓存算法基准及冻结产物的真实浏览器前后对比 |
| `tests/browser/` | Playwright `.spec.mjs`；实际客户端在 Chromium 中的布局、交互和截图 |

文件系统测试只使用隔离临时目录，不能连接真实资料库。测试退出前清理自己的文件，移除路径前验证边界。模块装配测试在 VM 中验证注册和释放，不代表实际浏览器布局或完整 UI 端到端测试。

CI 使用 Ubuntu/Windows × Node 22/24 矩阵，执行构建、完整测试、发布检查、可重复构建、生产依赖审计和 npm 打包预览。Windows 阶段目录发布仅对 EPERM/EACCES/EBUSY 做 20/40/80ms 的有限原子 rename 重试；重试使用同一路径，永久失败保留旧指针。确定性故障测试验证重试上限、旧路由和重启结果。

## 自动浏览器验收

```sh
# 首次在未安装浏览器的环境执行；Windows 也可使用已安装的 Chrome
npx playwright install chromium
npm run test:ui
```

`test:ui` 先构建正式入口，再在 Chromium 中加载实际 Client。测试 origin 的 HTTP 由实际 Host 业务服务加私有内存表接管，不启动替代 Web 服务器、不读取用户资料。开发依赖 React/ReactDOM 仅为宿主适配器提供测试运行时，不进入正式 Client 依赖图；模块边界测试继续拒绝打包第二份 React。

独立 Ubuntu browser CI 安装 Chromium 后执行该命令，并上传截图和失败 trace。输出位于 `.build/ui/` 与 `.build/browser-results/`；完整覆盖范围和宿主原生会话边界见 [UI 设计规格](ui-design.md)。这些真实浏览器用例不能替代全部真实 DSH 安装环境的人工验收。

## 大正文基准

```sh
npm run bench:client
npm run bench:workspace
```

浏览器 [workspace.bench.mjs](../../tests/performance/workspace.bench.mjs) 可指定冻结的 `--client`、`--host`、`--output`、`--sizes` 和 `--label`，固定种子与设备口径，验证真实键入及持久正文长度。新异步预览必须等待 `data-md-preview-state="ready"` 再稳定两帧；调整等待方法后需要以同版脚本重跑 baseline。不得与其他浏览器套件并行争用测试资源。方法与边界见[工作区性能规格](performance-and-workbench.md)。

下面保留旧同步缓存算法的历史数据；它不代表当前浏览器 IndexedDB + CodeMirror 的端到端表现。


[基准脚本](../../tests/performance/client-drafts.bench.mjs) 使用真实 `NoteEditSession` / `NoteDraftCache` 和内存 Storage，对 100,000 / 1,000,000 / 5,000,000 个 UTF-16 单元的正文分别执行 25 次输入，记录同步 change 的 p50/p95、JSON UTF-8 累计字节及写次数。每轮验证新 cache 实例能恢复精确正文，并确认 durability 状态。

一次开发机采样：

| 正文规模 | p50 | p95 | 25 次累计 JSON 字节 |
| --- | --- | --- | --- |
| 100K | 约 0.67ms | 约 1.23ms | 5,839,140 |
| 1M | 约 5.86ms | 约 8.04ms | 58,339,140 |
| 5M | 约 31.07ms | 约 33.06ms | 291,672,490 |

这是算法、校验、JSON 序列化和内存 Storage 成本，不包含真实浏览器 localStorage I/O、配额、React 渲染、Markdown 预览或网络。样本较少且未作严格统计实验，数值仅用于确定优化方向，不作为 SLA。5M 的旧同步路径已可能跨越单帧预算，当前浏览器已改为异步合并事务；其收益须另用真实浏览器基准衡量。

## 浏览器人工验收

在兼容的 DSH 中安装本次打包产物并按宿主要求刷新，逐项检查：

1. 从侧边栏打开笔记，切换中英文、字体、网格/列表和窄屏布局。
2. 创建普通笔记，以及在「日记」分类中新建当天日记，短标题首次输入、正文自动保存、手动快照和重新打开均正确。
3. 两个标签页交错编辑产生冲突，保留各自草稿；载入最新与另存副本行为符合提示。
4. 刷新/关闭再打开恢复草稿；模拟本地配额失败时状态和关闭提示真实，不能显示“已持久化”。
5. 上传多个文件、中途取消、核对列表、插入引用、软移除，再从正文和历史打开文件。
6. 打开原生共写，复用/新建会话，AI 修改后在空闲时同步；脏编辑器不被覆盖。
7. 对 100K/1M/5M 正文记录输入长任务、IndexedDB 事务、预览切换、DOM/内存及恢复结果；同时覆盖长单块内容和折叠目录。
8. 使用隔离资料验证目录切换、重启和附件引用，检查本机 Windows 文件系统异常。

自动测试完成不等于上述实际 DSH 浏览器验收已完成。安装、更新或发布属于独立操作，不由构建脚本隐式执行。
