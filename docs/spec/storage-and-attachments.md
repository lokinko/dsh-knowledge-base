# 存储与附件规格

实现：[NoteStorage](../../src/host/storage/note-storage.js)、[域 schema](../../src/host/domain-spec.js)、[附件 Store](../../src/host/attachments/store.js)、[二进制存储](../../src/host/attachments/storage.js)。

## 存储域与兼容

域名为 `dsh_note`，版本为 1，包含 `notes`、`note_versions`、`note_chats`、`note_categories`、`note_topics`、`note_storage`、`attachments`、`migration` 八张表。资料身份与控制指针保存在 `note_storage` 的 `state` 键：`libraryId/revision/directory/generation/updatedAt`。

以下标识必须保持兼容：插件 id `dsh-note`、HTTP `/api/dsh-note`、`dsh_note` 域、存储格式 `dsh.todo-manager.notebook`、既有笔记 UUID、版本标识、附件 ID、`ctx1` 引用及旧草稿键。重命名源文件不构成资料迁移，不应修改这些持久标识。

## 两种路由

默认模式使用宿主域表和附件服务，启动时读取校验后的内存表快照。自定义目录模式使用所选 Host 绝对目录下的 `dsh-notebook` 子目录，主要结构为：

```text
dsh-notebook/
  library.json
  .lock
  generations/
    <generation UUID>/
      generation.json
      notes/<SHA-256 of key>.json
      note_versions/<SHA-256 of key>.json
      note_chats/<SHA-256 of key>.json
      note_categories/<SHA-256 of key>.json
      note_topics/<SHA-256 of key>.json
      attachments/<SHA-256 of key>.json
      blobs/<content SHA-256>
```

锁回收期间另有 `.reclaim.lock`，迁移暂存目录以 `.stage-` 开头。受管理路径不接受符号链接、非预期文件类型或其他资料库的 ownership marker。选定目录不存在/损坏时启动失败，不自动打开空白默认库。

旧 generation 没有声明 `note_categories` 时按空分类表打开，显示兼容的内置分类；首次分类写入安全升级到包含分类表的新 generation。已声明的新表目录缺失则拒绝打开。分类随同笔记及附件迁移，详见[树形分类](categories.md)。

普通记录写入采用同目录临时文件、文件 fsync、rename、可用平台上的目录 fsync；持久化成功后才更新内存表。Windows 的目录 fsync 不可移植，代码保留明确的兼容处理。单条原子替换不等于跨表事务。

## 目录切换提交协议

1. `status` 获取当前控制 revision；`check` 验证目标，`set` 要求当前 revision。
2. 规范化目标 Host 绝对路径，校验归属并获取进程锁。
3. 与全部表写入共享队列，捕获当前资料并向新 generation 写入笔记、历史、绑定、附件元信息及原始文件。
4. 完整校验新 generation；提交持久控制指针后，才切换活动内存路由。
5. 失败保留原控制指针和原活动路由；原始数据与旧 generation 不自动清除。返回默认模式会核对默认表，控制提交失败时尝试回滚准备工作。

同一路径设置为无变化操作。迁移中的上传和普通写入按实际进入存储队列的顺序解析活动路由。已取得的附件读取描述符可继续访问保留的旧 generation。

进程锁拒绝活跃占用；只有证明旧 PID 已退出才尝试回收普通锁。回收 guard 不递归自动回收，异常 guard 需要明确人工恢复。默认模式仍要求单实例写入，见 [架构约束](architecture.md)。

## 附件行为

- 附件只关联 note，拒绝 task 等其他业务所有者；新上传需对应有效笔记。
- 文件字节通过流传输，元信息保存名称、大小、媒体类型、SHA-256、宿主引用、revision 和移除标记，不将二进制内容写入 JSON。
- 二进制验证使用有界块，完整消费到 EOF 时校验长度及 SHA-256。冷启动主要核对文件存在与大小；相同大小的内容篡改在完整读取或迁移校验时发现。
- “移出列表”写入软移除元信息，保留文件及旧正文/历史引用；不等同永久删除或垃圾回收。
- 完整下载流校验到 EOF；Range 请求可提前停止，不能宣称该次局部读取完成了全文件哈希验证。
- 下载支持 GET/HEAD、单段 byte Range、ETag/If-Range。PNG/JPEG/GIF/WebP/PDF 可 inline，其余按 octet-stream 下载；设置 Content-Disposition、nosniff、CSP 和 private/no-store。
- 浏览器批量上传逐个执行，中断或响应丢失后重新列举核对，因为 Host 写入可能已提交。取消客户端请求不承诺回滚服务器已保存文件。

旧 `/api/local-todo-manager/attachment-file` 引用仅在 Markdown 渲染时映射到新接口。保留原始正文；旧组合版迁移凭据为 pending 时禁止启用新插件。独立旧笔记插件应停用，避免双入口写入。

## 验收

[存储测试](../../tests/host/note-storage.test.mjs) 覆盖控制 revision、失败提交、重启、跨进程锁和路径保护；[附件存储测试](../../tests/host/attachment-storage.test.mjs) 覆盖多次迁移、完整性、流中断及软移除引用；[独立 Host 测试](../../tests/integration/independent-host.test.mjs) 验证域与业务隔离。
