# Memory 面板实现计划

> 执行者按此计划在当前 `feat/pet-ui` 分支逐项实现。协议缺项不在本分支改 petd。

**目标：** 将 `memory-panel-spec.md` 落成 Memory 导航页，并把附件上传/发送接入聊天。

**结构：** 新建独立 `MemoryPanel` 管理树、正文、历史和附件；Electron main 只通过受限 IPC 根据 workspace 与 BlobMeta 提供本地缩略图和媒体 URL；聊天页共享待发送句柄。

**约束：** 仅改 `apps/pet-ui/**`；不加依赖、不改 petd/protocol；缺少 `memory.changed`、`blob.preview`、`memory.restore` 时给出明确提示；不把列表图片 base64 通过 WS 传输。

## 文件

- 修改 `src/ui.tsx`：导航、MemoryPanel 挂载、附件队列和 chat.send。
- 新建 `src/memory-panel.tsx`：树、编辑/预览、历史/diff、附件列表/上传和大图预览。
- 新建 `src/memory-panel.css`：三栏面板与冲突/预览样式。
- 修改 `src/main.tsx`：导入面板样式。
- 修改 `electron/main.mjs` / `electron/preload.cjs`：workspace 校验、SHA-256 缩略图缓存、本地媒体 URL IPC。
- 修改 `src/petd.ts`：preload IPC 类型。
- 修改 `README.md`：标记面板能力及待接方法。

## 步骤

- [x] 完成受限本地附件 IPC，路径必须限制在 `<workspace>/blobs/`。
- [x] 完成 Memory 左树、中编辑/预览、右历史/附件布局；通过 `memory.status/list/read/write/history/diff` 工作。
- [x] 加入文件级草稿基线检查与载入最新/显式覆盖冲突提示；监听未来 `memory.changed`。
- [x] 接入附件缩略图、`blob.preview` 待接提示、`blob.get` 原图、媒体预览、`blob.put/delete` 和聊天附件队列。
- [x] 完成最终构建、diff 检查和中文提交；不运行测试套件。

## 验收

- `pnpm --filter @petd/pet-ui build` 通过。
- `git diff --check` 通过且最终改动只在 `apps/pet-ui/**`。
- 缺少待接方法时界面可用、错误清楚，不静默伪造成功。
