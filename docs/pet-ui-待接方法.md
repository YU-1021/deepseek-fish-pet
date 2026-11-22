# pet-ui 待接协议方法：Memory 面板

此文件列出 UI 开发所需、当前 petd 尚未提供的协议项。实现后请同步更新 `apps/pet-ui/docs/memory-panel-spec.md` 对照的字段和验收项。

## 1. `memory.status` 增加 workspace

保留现有 `dir`，新增 `workspace: string`，为工作区规范化后的绝对路径。pet-ui 主进程用它定位本机 `blobs/`，renderer 不直接访问文件系统。

## 2. `memory.write` 并发冲突

在现有参数上增加：

```ts
expectedContentHash?: string; // 当前编辑基线正文 UTF-8 字节的 SHA-256，小写 hex
force?: boolean;              // 只在用户确认“覆盖”后传 true
```

当文件当前 hash 与 `expectedContentHash` 不一致且 `force !== true` 时，不写文件、不创建提交，返回 `E_CONFLICT`。`force:true` 表示用户明确选择覆盖。返回值继续使用现有 `{path,bytes,commit}`。

## 3. `memory.changed` 事件

所有记忆写入来源（`memory.*` UI 方法、聊天记忆工具及未来 petd 写入）成功后广播。事件 `data`：

```ts
{
  operation: 'write' | 'append' | 'delete' | 'move' | 'restore';
  path?: string;       // write/append/delete/restore
  from?: string;       // move
  to?: string;         // move
  commit: string | null;
}
```

事件帧时间戳使用现有 event frame 的顶层 `ts`。提交不可用或没有生成提交时 `commit` 为 `null`。`move` 同时带 `from` 和 `to`。

## 4. `memory.restore`

参数：

```ts
{ path: string; hash: string; expectedContentHash?: string; force?: boolean }
```

结果沿用 `{path,bytes,commit}`。读取 `hash` 版本中的 `path` 内容，将其写回当前工作区并生成一条**新的**提交；禁止 reset/checkout 改写历史。支持与 `memory.write` 相同的冲突语义。仍执行工作区路径安全校验；`PARTNER.md` 可恢复正文，但不可删除或移动。

## 5. `blob.preview`

参数：`{ref: string, maxChars?: number}`。

结果：`{meta: BlobMeta, text: string, truncated: boolean}`。仅支持可识别文本 MIME；默认最多 4096 字符、最大 16384 字符，超出截断并令 `truncated=true`。二进制或不可识别文本返回 `E_BAD_PARAMS`。列表预览使用它，不调用 `blob.get` 拉整份 base64。

## 已有接口复用

- `memory.tree/list/read/history/diff`：记忆树、目录项、正文、提交列表和差异。
- `blob.list/get/put/delete`：附件元数据、用户点开时取原图、上传、删除。
- `chat.send` 已接受 `attachments: string[]`，UI 传 `blob:<name>` 句柄，最多 10 个。

对应完整 UI 行为和验收清单见 `apps/pet-ui/docs/memory-panel-spec.md`。

## 智能审批门：配置写入

当前 petd 只提供 `config.get`，没有可供 UI 安全修改 `hooks.*` 配置的写入方法。`hooks.status` 只读，`hooks.toggle` 只控制单条规则；`hooks.update` 更新规则字段，不能修改审批门全局设置。

建议新增 `config.patch`（或 `hooks.configure`）支持部分更新：

```ts
{
  hooks?: {
    enabled?: boolean;
    mode?: 'rules' | 'smart';
    approvalEnabled?: boolean;
    approvalTimeoutMs?: number;
    risk?: { enabled?: boolean };
  }
}
```

需校验 `approvalTimeoutMs` 的安全上下限并返回更新后的配置。UI 在该方法上线前仅展示当前状态，不伪造可保存的模式/开关控件。
