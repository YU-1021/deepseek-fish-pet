# app · 大肥鱼桌宠（源码目录）

完整说明见仓库根目录的 [`../README.md`](../README.md)。

## 快速开始

```powershell
npm install
npm start
```

首次启动没有 API Key 会弹出绑定窗口（任意 OpenAI 兼容接口，默认 DeepSeek 官方）。

## 构建

```powershell
npm run dist     # electron-builder --win nsis，输出到 app/dist
```

## 语音识别

默认使用 **本地 whisper.cpp**（离线，无需 Key）。识别模型不随仓库发布：

- 对话窗里点 **🎤 → ⬇ 下载语音模型**（约 75MB，hf-mirror 镜像）；或
- 手动把 `ggml-tiny.en.bin` 放到 `%APPDATA%\dayu-pet\asr\`
