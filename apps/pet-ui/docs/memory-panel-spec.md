# Memory 面板规格（可转发）

> 目标：在 pet-ui 提供可编辑、可追溯的工作区记忆面板，并能在聊天中管理附件。UI 只调用 petd 协议；Electron 主进程只负责本机附件缩略图/文件访问，不把业务读写移出 petd。

## 1. 页面布局

- **左栏：记忆树**。目录在前，显示文件名、大小和更新时间；点击文件加载正文。常驻文件置灰并带「常驻」徽标，但仍允许编辑正文；禁用删除和移动。
- **中栏：编辑器 / Markdown 预览**。顶部显示路径、保存状态与「编辑 / 预览」切换；编辑后显式点保存，避免每次输入都产生 Git 提交。保存成功显示提交短 hash。
- **右栏：`历史` / `附件` 两个 Tab**。
  - 历史按当前选中文件过滤；点提交看 diff，再点「恢复此版本」。
  - 附件显示本地缩略图/文本摘要、文件名、类型、大小和句柄；选中附件可在聊天中使用或删除。
- **聊天附件**：选择文件后先上传并显示待发送附件；发送时把句柄数组附到 `chat.send`。图片在聊天中点击后再取原图放大预览。

## 2. 数据来源与方法映射

| 面板数据/动作 | 方法或来源 | 说明 |
|---|---|---|
| 工作区状态、Git HEAD | `memory.status {}` | 当前 petd 返回绝对路径字段为 `dir`；面板读取 `workspace ?? dir`。建议 petd 增加 `workspace` 别名以固定语义。 |
| 初始树展示 | `memory.tree {}` | 返回 `{tree: string}`；若需逐项展开/刷新，使用下面的 `memory.list`。 |
| 当前目录的子项 | `memory.list {dir?}` | 返回 `{dir, entries:[{name,path,type,size,mtimeMs}]}`；展开目录时按需调用。 |
| 文件正文 | `memory.read {path}` | 返回 `{path,content}`；加载时同时在 UI 计算正文 SHA-256，作为后续写入基线。 |
| 保存正文 | `memory.write {path,content,expectedContentHash?}` | 成功返回 `{path,bytes,commit}`；需增加下文的冲突语义。 |
| 文件历史 | `memory.history {path,limit?}` | 返回 `{commits:[{hash,fullHash,author,date,message}]}`；按当前文件过滤。 |
| 某次提交的差异 | `memory.diff {hash,path}` | 返回 `{diff:string}`；按 unified diff 展示。 |
| 恢复旧版本 | **新增 `memory.restore`** | 见「待 petd 接方法」；必须写回旧内容并产生一个新提交，不移动 HEAD、不重写历史。 |
| 附件列表 | `blob.list {}` | 返回 `{blobs: BlobMeta[]}`；元数据包含 `handle,path,name,mime,size,sha256,createdAt`。 |
| 文本附件摘要 | **新增 `blob.preview {ref,maxChars?}`** | 返回 `meta` 和有长度上限的 `text` 摘录；列表不取完整 base64。 |
| 聊天中点开图片原图 | `blob.get {ref}` | 返回 `{meta,dataBase64}`；仅用户点开大图时调用。 |
| 上传附件 | `blob.put {dataBase64,name?,mime?}` | 返回 BlobMeta；单文件实际上限 8 MiB。UI 上传后暂存 `meta.handle`。 |
| 删除附件 | `blob.delete {ref}` | 物理删除；删除前二次确认，若附件仍在待发送列表则同步移除。 |
| 发送消息和附件 | `chat.send {sessionId?,text,attachments?:string[]}` | `attachments` 放 blob handle，最多 10 个；响应及 `chat.user_message` 事件可用于显示附件元数据。 |

### 附件分类

当前 BlobMeta 提供 `mime`，没有 `kind` 字段；pet-ui 用 MIME 前缀派生分类：`image/*`、`text/*`（另兼容 JSON/YAML 等已知文本 MIME）、`audio/*`、`video/*`，其余为通用文件。若 petd 后续提供 `kind`，UI 优先用它并保留 MIME 兜底。

## 3. 关键交互

### 3.1 并发冲突

打开文件时保存本地基线 hash。保存时 `memory.write` 带 `expectedContentHash`；petd 在写入前比较当前文件内容，基线不符时返回 `E_CONFLICT`，且不覆盖文件。

冲突提示提供两个按钮：

- **载入最新**：调用 `memory.read`，用服务端正文替换编辑区并更新基线 hash；未保存草稿先暂存在冲突弹窗内，用户可复制。
- **覆盖**：再次显示将覆盖他人修改的确认；确认后以 `force:true` 写入。`force` 必须由 petd 明确定义并支持，不能通过重试普通写入绕过冲突。

### 3.2 实时刷新

订阅 `memory.changed`。事件至少携带 `{operation,path,from?,to?,commit}`；发生在当前目录时刷新树，发生在当前文件时重新读取正文并检查是否与本地草稿冲突。其他目录只更新状态/计数，不打断正在编辑的内容。窗口恢复连接后主动重新请求 `memory.status` 和当前 `memory.list/read`，不依赖补收旧事件。

### 3.3 常驻文件

用 `PARTNER.md` 标记常驻文件：树中置灰并显示「常驻」徽标；仍可打开和保存正文。禁用删除、移动/改名，和后端现有 `E_FORBIDDEN` 规则一致。不要把 `blobs/` 中的附件误当成记忆文件加入树。

### 3.4 附件预览、上传和发送

- 列表先调 `blob.list` 取元数据，不经 WS 请求图片 base64。
- `memory.status` 提供 workspace 绝对路径（当前字段 `dir`；推荐补 `workspace`）。主进程以 `path.resolve(workspace,'blobs',meta.name)` 定位文件，并校验规范化后的路径仍在该 blobs 目录内。
- **图片缩略图**：主进程调用 `nativeImage.createThumbnailFromPath(absPath,{width:256,height:256})`（或 `createFromPath` 后 `resize`），只把缩略图 data URL 回给 renderer；按 `meta.sha256` 缓存，内容不变即可复用。
- **文本**：调 `blob.preview`，用返回的 `text` 做摘要，截断状态也由响应给出；不拉整份 base64。
- **音频/视频**：按派生的 kind 使用 `<audio>/<video>` 播放；也可经窄 IPC 交给系统播放器。renderer 不直接访问 fs。
- **聊天大图**：用户点击图片后才调用 `blob.get`，以 `dataBase64` 打开原图预览。
- **上传**：`blob.put` 返回句柄后把 `handle` 放进待发送附件；`chat.send.attachments` 发送句柄数组。上传失败不清空草稿和其他已选附件；发送失败保留待发送附件，成功后清空。

### 3.5 历史与恢复

流程固定为「提交列表 → 选提交 → `memory.diff` → 查看差异 → 确认恢复」。恢复是把所选提交中该文件的旧内容写回当前工作区，再创建一条新的 Git 提交；不能 `reset`、`checkout` 整个仓库或改写历史。恢复成功后重新读取正文、刷新历史，并选中新生成的提交。

## 4. 需要 petd 补齐的协议项

当前代码核对结果：`memory.status` 返回 `dir` 而非 `workspace`；没有 `memory.changed` 事件、`blob.preview` 或 `memory.restore`；`memory.write` 也没有并发基线参数。请 petd 按以下约定补齐后 UI 再接入：

1. **`memory.status`**：新增 `workspace` 绝对路径字段；暂时保留 `dir` 兼容已有客户端。
2. **`memory.write`**：新增可选 `expectedContentHash` 与 `force`。基线不一致且 `force !== true` 时返回 `E_CONFLICT`，不得写盘或提交；`force:true` 仅用于用户明确确认的覆盖。
3. **`memory.changed`**：所有来源的记忆写入（UI、聊天记忆工具、外部 petd 操作）成功后广播；覆盖 write/append/delete/move/restore，携带操作、路径和提交 hash。
4. **`memory.restore {path,hash}`**：读取指定提交中的该路径版本，写回当前工作区并产生新提交；参数路径仍遵守工作区安全校验；常驻文件允许恢复内容但仍禁止删除/移动。
5. **`blob.preview {ref,maxChars?}`**：返回 `{meta,text,truncated}`；只适用于可识别文本，输出有上限（建议默认 4 KiB、最大 16 KiB）；二进制返回 `E_BAD_PARAMS`。

附件缩略图和播放 URL 是 pet-ui 主进程本地能力，不需要增加 petd 协议方法。

## 5. 验收清单

- [ ] 面板按左树 / 中编辑预览 / 右历史附件 Tab 显示；目录展开和文件选择来自 `memory.list/read`。
- [ ] Markdown 编辑、预览、显式保存可用；成功显示提交 hash。
- [ ] 两个客户端同时改同一文件时，旧基线保存返回 `E_CONFLICT`；载入最新更新正文和基线，覆盖需二次确认。
- [ ] petd/聊天工具改动记忆后，`memory.changed` 刷新树；当前文件有草稿时提示冲突，不静默覆盖。
- [ ] `PARTNER.md` 显示常驻徽标、可改正文、不可删除或移动。
- [ ] 历史列表和 diff 正确；恢复旧版本会产生新提交且旧提交仍可见。
- [ ] 附件列表只传元数据；图片缩略图走主进程本地文件和 SHA-256 缓存；文本摘要只显示 `blob.preview.text`。
- [ ] 点击图片大图时才调用 `blob.get`；音频/视频可播放或打开系统播放器。
- [ ] 上传附件后 `chat.send` 收到句柄数组；最多 10 个，单文件不超过 8 MiB；失败时保留待发送附件。
- [ ] renderer 不直接读写 fs；缩略图路径被限制在当前 workspace 的 `blobs/` 内。
- [ ] pet-ui 只依赖已上线协议及本文列出的 petd 补充项；未知事件忽略，断线重连后重新拉取当前状态。
