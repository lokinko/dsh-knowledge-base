# 树形笔记分类规格

## 数据与兼容

分类是资料库中的独立树，笔记继续通过原有 `category` 字段引用分类 ID。四个内置 ID 为 `document`、`reading`、`code`、`journal`；新增分类使用 Host 生成的 UUID。调整名称、顺序或父分类不会重写笔记正文、历史版本或草稿中的 ID。

`note_categories` 表保存单条记录，键与记录 `id` 均为 `categories`：

```js
{
  id: 'categories',
  revision: 1,
  items: [{id, name, parentId: null, order: 0}],
  redirects: [{id: 'deleted-category-id', targetId: 'remaining-category-id'}] // optional
}
```

`parentId: null` 表示根级，`order` 是同级从零连续的序号。未保存过分类树的旧资料库返回 revision 0 和四个内置根分类；内置空名称由客户端根据界面语言显示。自定义名称不能为空，最多 80 字符。同级自定义分类名称不能重复，最多 500 个活动分类、8 层深度，且至少保留一个分类。完整树校验拒绝未通过 `redirects` 记录的内置 ID 缺失、重复 ID、孤立父节点、环和不连续序号。`redirects` 最多保留 10,000 个已删除 ID，每个目标必须是当前活动分类；再次删除目标时会直接更新旧映射，不形成重定向链。

域版本保持 1，增加空表符合宿主现有新增表语义。目录存储将分类表作为可选表：旧三表/附件四表 generation 可无写入打开；首次分类写入复制当前启用表与附件、提交新 generation，再以存储指针 CAS 切换。已声明分类表的 generation 缺少该目录时必须报错。分类跟随资料库切换、回到默认存储及重启，不保存在浏览器本机配置中。

## HTTP 与工具

认证路由 `/api/dsh-note/categories` 支持 GET/POST，同一操作通过 `manage_note_categories` 工具调用。成功返回 `{ok:true, tree:{id, revision, items}}`。

| action | 参数 | 行为 |
| --- | --- | --- |
| list | 无 | 读取完整有序分类树 |
| create | revision、name、可选 parentId | 创建根分类或子分类，返回稳定 UUID |
| update | revision、id、name | 更新名称，保持 ID 与笔记引用 |
| move | revision、id、parentId、可选 beforeId | 移动整棵子树；beforeId 为空时置于目标同级末尾 |
| delete | revision、id | 删除一个分类，直接子分类在原位置提升一级；笔记归入父分类，根分类归入删除后第一个根分类 |

写入均使用树 revision 做 CAS。无变化的移动或更新不增加 revision。移动目标必须是目标父节点下的兄弟节点；不能放到自身前面、移入自身或后代，也不能使子树超过深度限制。失败不写入部分树，队列继续可用。

笔记 HTTP 与 `manage_notes` 的 category 接受内置 ID 或已有的自定义 UUID；创建和修改分类归属时校验存在。列表过滤父分类默认包含所有后代，可通过 `includeDescendants:false` 仅查看直接归属。分类 counts 汇总后代，all/trash 数量不重复累加。NotesStore 请求在入队时预约分类快照，防止后提交的分类移动改变先前请求的筛选含义。

删除通过一次分类表提交保存目标映射，避免跨笔记批量更新产生部分迁移。原笔记、历史版本、附件、会话与草稿 ID 均保留；读取、检索、统计和后续编辑按目标分类解析旧 ID。默认分类同样可以删除，最后一个分类受保护。子分类提升引起同级重名等校验失败时不写入部分树。

目录行右侧使用“分类操作”菜单，提供“新增子分类”和“删除分类”，支持方向键、Escape、点击外部关闭与取消后焦点返回。删除确认显示笔记接收分类，默认聚焦“取消”，确认绑定打开时的树 revision。先排空当前笔记保存，删除成功后更新当前编辑会话的分类并刷新目录，保持正文编辑器及撤销历史。界面不会自动删除真实分类。

## 验证

模型与存储回归覆盖 CAS 并发、队列恢复、排序、跨父级子树移动、循环/深度边界、默认兼容、父过滤/counts、分类 UUID 存在校验，以及旧目录升级、失败指针回滚、附件完整性、切换和重启。

客户端回归覆盖排序/路径/拖放映射、钩子过期请求与冲突、离线自定义分类草稿恢复。Chromium 用例通过实际 Host 内存适配器验证新增父子分类、笔记归类、改名不写笔记、页面重开、真实鼠标拖放、移动端替代操作及冲突重试。截图均使用隔离示例分类。
