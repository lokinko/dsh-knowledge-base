# 笔记与检索规格

实现入口：[笔记 Store](../../src/host/notes/store.js)、[接入适配](../../src/host/notes/host.js)、[字面编辑](../../src/host/notes/edits.js)、[检索](../../src/host/search/context-search.js)。

## 笔记契约

`list` 默认返回每篇前 160 个 UTF-16 代码单元的 `excerpt`，仍不返回完整 `content`。可选 `excerptLength` 为 0–1,600 的整数；笔记库卡片显式请求 1,600，目录和其他默认调用保持短摘要。该读取不改写笔记、revision 或历史。

| 字段 | 当前约束 |
| --- | --- |
| `id` / `revision` | UUID；正安全整数。实际变更递增 revision，无变化保持原值 |
| `title` / `content` | 标题最多 200 个 UTF-16 代码单元；正文为字符串，无固定字数上限 |
| `category` | 内置 `document`、`reading`、`code`、`journal`，或已有自定义分类 UUID；参见[树形分类](categories.md) |
| `tags` | 最多 20 个、不重复，每个 1–40 个字符；服务端不静默修剪或改写 |
| `pinned` / `journalDate` | 布尔值；空字符串或真实 `YYYY-MM-DD` 日历日期 |
| `trashedAt` | 空字符串表示有效笔记，否则为 ISO 时间 |
| `createdAt` / `updatedAt` | ISO 时间 |

正文必须原样保留空白、CRLF、Unicode 和代码。显示预览、旧附件链接映射及检索分块不得重写保存的 Markdown。

`update`、`trash`、`restore`、`checkpoint`、`restore_version` 必须携带当前 revision；过期写入返回 `CONFLICT`。回收站中的笔记拒绝编辑，必须先恢复。`journal(date)` 返回该日期已有的有效日记，或创建新记录。

## HTTP 与工具

HTTP 路径统一以 `/api/dsh-note` 开头，由 DSH Connection 接入。

| 路径 | 方法 | 工具/职责 |
| --- | --- | --- |
| `/notes` | GET、POST | `manage_notes`；GET 为默认列表，POST 按 action 分派 |
| `/categories` | GET、POST | `manage_note_categories`；分类树读取、创建、改名及移动 |
| `/note-edits` | POST | `edit_note`；字面替换或追加 |
| `/context` | POST | `search_notes`；词法检索和精确源文读取 |
| `/note-storage` | GET、POST | `manage_note_storage`；状态、检查与切换 |
| `/coauthor` | POST | `manage_note_chat`；绑定查询/创建 |
| `/attachments` | POST | `manage_note_attachments`；附件元信息 |
| `/attachment-upload` | POST | 原始二进制上传 |
| `/attachment-file` | GET、HEAD | 文件读取、下载及 Range |

`manage_notes` 支持 `list/get/create/journal/update/trash/restore/checkpoint/versions/version/restore_version`。列表和写入返回元信息；浏览器 `get/version` 取得完整正文。工具 `get/version` 默认返回 16,000 字符，单次最多 50,000，通过 `nextContentOffset` 继续。偏移采用 JavaScript UTF-16 字符串索引。

JSON 接口成功含 `ok:true`，失败含 `ok:false/code/error`。笔记与编辑适配将冲突映射为 HTTP 409、缺失映射为 404，其余多为 400；不同子接口保留各自已实现的错误码，不假设全局统一。检索/会话请求增量读取并限制为 32 KiB。笔记/编辑请求允许长正文，虽然注册为 streaming，当前仍用 `request.text()` 完整读取后 JSON 解析，并非增量正文解析器。

## 历史与字面编辑

标题/正文变更自动保存前一版，自动快照间隔为五分钟；手动 checkpoint、移入回收站、版本恢复以及 `edit_note` 的实际修改强制保留快照。每篇最多 50 份，版本标识为 `noteId:revision`。恢复历史只恢复标题和正文，保留当前分类、标签等属性。

`edit_note` 先校验 revision 和匹配位置，再 checkpoint，最终通过同一 Store 的 revision 检查更新。默认替换必须唯一，支持非重叠 `replaceAll`；追加只在 EOF 写入指定原文，不隐式增加换行。无变化不写历史。

历史与当前笔记是多条持久化操作，不构成数据库事务。历史失败阻止覆盖当前笔记；历史成功后当前记录写入失败时，已写历史及其保留清理不会整体回滚。

## 检索一致性与成本

- 全库检索通过内部 `NotesStore.searchSnapshot()` 一次加入同一业务队列，取得校验后与存储引用分离的完整记录集合。先前写入完成后捕获，后续同实例写入等待捕获完成。
- 检索不得使用按更新时间/置顶排序的偏移分页循环，避免并发更新把记录移过分页边界。一次全库检索只枚举一次笔记表，不重复调用公开 list/get。
- 指定非空 `documentId` 时直接读取该笔记，不枚举全表、不清除其他文档缓存；缺失或非 UUID 标识返回空匹配。
- 快照之后的排序、分块和评分读取已捕获内容。结果反映捕获时点，不能保证返回时仍是最新版本。
- 缓存是可重建派生视图，依据 revision、时间、内容指纹和元信息更新。全库快照才可清理已消失记录的缓存。
- 当前为词法检索，使用 Unicode 规范化、中文子串及标题/标签/段落权重；没有向量索引或持久化全文索引。全库枚举与正文处理仍随资料量增长，不能描述为 O(1) 查询。

## 来源引用与分块

`ctx1:` atomId 编码来源、笔记 ID、字段、revision、updatedAt、正文指纹和 UTF-16 起止偏移。它是定位信息，不是权限凭据。段落、标题与代码围栏帮助切块；正文大块约 2,400–3,000 个 UTF-16 单元。

搜索默认最多返回 12 条，上限 40；摘要默认 400，上限 600。读取默认 6,000 字符，上限 20,000，继续使用 `nextAtomId/nextStart`。读操作重新校验当前正文与引用版本，变化返回 `CONFLICT`，缺失返回 `MISSING`；回收站内容需要 `includeTrashed`。检索分块读取避免截断代理对。

回归验收见 [检索测试](../../tests/host/context-search.test.mjs)，包含 101 篇笔记并发排序变化、快照队列边界、单文档直达、缓存失效及过期引用。
