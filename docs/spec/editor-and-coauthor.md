# 编辑器与共写规格

实现：[编辑协调器](../../src/client/notes/edit-session.js)、[导航](../../src/client/notes/navigation.js)、[UI](../../src/client/notes/ui.js)、[前端会话](../../src/client/coauthor/ui.js)、[Host 绑定](../../src/host/coauthor/note-chats.js)。

## 草稿与持久性

浏览器使用 [BrowserNoteDraftCache](../../src/client/notes/browser-draft-cache.js) 的内存索引和异步 IndexedDB 事务。兼容旧前缀 `dsh.todo-manager.note-draft.v1:`；键继续按笔记 ID 与 writer ID 隔离，记录包含 baseRevision、完整字段、时间和来源身份。旧同步 `NoteDraftCache` 仍用于兼容读取、明确回退及原契约测试。

每次实际变更先同步校验并更新精确内存原文，再通知订阅者、安排默认 900ms 的远端保存。浏览器约 30ms 合并本机事务，不逐键 JSON 序列化全篇。相同内容不重写草稿、不延长防抖。标签数组等值也视为无变化。

`cachePending=true` 表示本机事务未提交，此时 `cacheDurable=false`。只有事务 complete 或服务器确认后才可显示已持久化。失败保留 volatile 内存副本与明确状态，支持重试及关闭提示。初始化失败不能静默展示空恢复库；fallback 必须提示先前草稿可能尚未完整读取。浏览器关闭提示不等于能够强制阻止退出或保证最终异步事务完成。

删除缓存使用精确 raw 快照保护，不删除其他标签页写入的更新。恢复旧 writer 草稿后，先为当前 writer 写独立副本，再安排保存；基于过期 revision 的草稿进入冲突状态，不能自动覆盖远端。

## 编辑状态与保存

| 状态 | 行为 |
| --- | --- |
| saved | 最新一代字段已被服务器确认，或接受了匹配远端状态 |
| pending / cache-error | 有本地变更；区分持久缓存成功与失败 |
| saving | 单个请求在途，后续输入继续保留，成功后基于返回 revision 串行提交 |
| offline | 暂时保存失败，保留草稿；手动 flush 或后续操作可重试 |
| conflict | 停止自动提交，保留本地字段；允许另存副本或明确载入最新内容 |

`flush()` 共享在途 Promise，不能重叠写入；远端确认只清理此次已提交的快照。组件暂停排空已接受编辑，恢复不重复延长防抖；abandon 终止旧会话并仅清理其掌握的草稿。

接收远端变更时，干净编辑器可更新字段并保留会话；本地脏字段不同则进入冲突。保存中的匹配远端状态也先保守处理，避免旧响应抹掉新冲突。HTTP 返回冲突但远端字段与提交完全一致时，UI 可将其作为已保存确认。

## 导航、渲染与界面设置

导航使用递增意图 ticket 和当前编辑 session token。异步请求只可打开仍有效的意图；旧笔记操作回调只可替换对应 token，不能覆盖用户后来打开的笔记。

Markdown 渲染关闭原始 HTML，公式使用 KaTeX `trust:false`，链接处理危险 URL，代码高亮仅启用指定语言。交互任务列表只修改对应原始 `[ ]/[x]` 字符，保留换行与其他字节语义。

正文使用 [CodeMirror 增量编辑器](../../src/client/editor/index.js) 和[即时渲染扩展](../../src/client/editor/live-preview.js)，只有一个编辑区域，不再提供编辑/预览/分屏切换。标题、粗体、斜体、引用与链接直接显示样式；代码块可直接编辑并高亮，公式使用 KaTeX 显示，点击可展开局部公式输入，排版结果随输入更新。图片与表格显示渲染结果，点击展开相应的 Markdown 输入。未闭合的数学标记保留原文，直到补齐后呈现。任务列表直接勾选。原文映射保留混合 CRLF/LF/CR，撤销与重做恢复分隔符；显示变化不会改写文稿。文档目录跳转到同一个编辑器中的原文位置，标题全量派生并窗口化，关闭时停止解析。历史等独立预览继续使用本地 Worker 和内容块窗口化。标题控件、字体、列表布局和聊天开关沿用现有机制。详见[工作区性能规格](performance-and-workbench.md)。

## DSH 原生共写

`get/start/current` 管理笔记与原生 Session 绑定。start 创建空白普通会话，不主动发送模型消息；重复 start 默认复用绑定，`newSession` 替换当前绑定。创建后保存绑定失败时，进程内保留候选以便重试，重启后不承诺恢复该候选。

`current` 根据当前 initiating Session 查找笔记元信息，身份只作定位键。原生会话由 DSH 管理，切换笔记资料目录不迁移 DSH 会话日志。替换绑定后旧会话不再由 current 定位到该笔记。

模型先查询绑定，再按需检索/分块读取，只有用户要求编辑时才使用小范围 revision 补丁。检索到的笔记是数据，不是系统指令。UI 在窗口 focus、手动刷新及会话空闲时同步远端，当前不提供笔记 SSE/WebSocket 推送或多人实时合并。

## 性能边界与验收

输入路径已移除浏览器逐键完整 JSON/localStorage 写入。正文变更与后台保存状态以 React transition 渲染，编辑器记住近期自身发出的正文，被打断的延迟渲染不会回滚输入；标题、日期与标签保持同步受控。IndexedDB 草稿驱动优先运行在内嵌 Worker，Worker 无法启动或打开数据库时回退主线程驱动；Worker 中断视为连接关闭（`InvalidStateError`），由重试重新打开。代码块编辑帧沿用映射后的旧着色，停顿约 80 ms 后在空闲时间重新高亮。全文字符串比较、IndexedDB 克隆、Worker 传输、解析和单个巨大内容块仍有随文稿规模增长的成本，不能把无字数上限描述为任意结构下都恒定耗时。实测口径与边界见[工作区性能规格](performance-and-workbench.md)。

缓存订阅在 start 绑定、pause/stop/abandon 解绑，避免关闭笔记后全局监听器持有完整旧正文。恢复按 key/raw/generation 同步暂停期间结果。手动保存继续接受正文输入，由已有串行 drain 提交后续修改。

验收包含[异步草稿测试](../../tests/client/browser-draft-cache.test.mjs)、[编辑协调测试](../../tests/client/note-edit-session.test.mjs)、[原文桥接测试](../../tests/client/editor-source.test.mjs)、[导航测试](../../tests/client/note-navigation.test.mjs)及[模块装配测试](../../tests/client/modules.test.mjs)。真实 Chromium 用例另行验证 IndexedDB 离线保存与重载恢复。
