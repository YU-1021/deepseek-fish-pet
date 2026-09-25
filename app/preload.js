const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('petAPI', {
  // 桌宠窗口（拖拽：渲染层只当触发器，主进程读真实光标坐标）
  dragStart: () => ipcRenderer.send('drag-start'),
  dragTick: () => ipcRenderer.send('drag-tick'),
  dragEnd: () => ipcRenderer.send('drag-end'),
  quit: () => ipcRenderer.send('quit'),
  onSay: (cb) => ipcRenderer.on('pet:say', (_e, data) => cb(data)),
  onChatState: (cb) => {
    ipcRenderer.on('chat:opened', () => cb(true));
    ipcRenderer.on('chat:closed', () => cb(false));
  },
  onFeed: (cb) => ipcRenderer.on('pet:feed', () => cb()),
  onPat: (cb) => ipcRenderer.on('pet:pat', () => cb()),
  onMicCheck: (cb) => ipcRenderer.on('pet:miccheck', () => cb()),
  logErr: (m) => ipcRenderer.send('log:error', m),
  // 本地语音识别（whisper）
  asrStatus: () => ipcRenderer.invoke('asr:status'),
  asrDownload: (name) => ipcRenderer.invoke('asr:download', name),
  asrTranscribe: (buf) => ipcRenderer.invoke('asr:transcribe', buf),
  onAsrProgress: (cb) => ipcRenderer.on('asr:progress', (_e, p) => cb(p)),
  onEndAsk: (cb) => ipcRenderer.on('memory:endAsk', () => cb()),
  openChat: () => ipcRenderer.send('chat:open'),
  chatClose: () => ipcRenderer.send('chat:close'),
  micNeedPermission: (reason) => ipcRenderer.send('mic:needPermission', reason),
  micOpenSettings: () => ipcRenderer.invoke('mic:openSettings'),
  onMicPermission: (cb) => ipcRenderer.on('mic:permission', (_e, r) => cb(r)),
  memoryEndSession: () => ipcRenderer.invoke('memory:endSession'),
  memorySession: () => ipcRenderer.invoke('memory:session'),
  onMemoryEnded: (cb) => ipcRenderer.on('memory:ended', (_e, r) => cb(r)),
  resize: (h) => ipcRenderer.send('pet:resize', { h }),
  setInteractive: (on) => ipcRenderer.send('pet:setInteractive', !!on),
  hitMask: (info) => ipcRenderer.send('pet:hitmask', info),
  hold: (on) => ipcRenderer.send('pet:hold', !!on),
  artRegions: () => ipcRenderer.invoke('art:regions'),
  shot: () => ipcRenderer.send('pet:shot'),
  chatShot: () => ipcRenderer.send('chat:shot'),
  // 配置
  configGet: () => ipcRenderer.invoke('config:get'),
  configSet: (patch) => ipcRenderer.invoke('config:set', patch),
  configTest: (patch) => ipcRenderer.invoke('config:test', patch),
  // 对话
  chatSend: (payload) => ipcRenderer.invoke('chat:send', payload),
  chatGreet: () => ipcRenderer.invoke('chat:greet'),
  chatReact: (kind) => ipcRenderer.invoke('chat:react', kind),
  chatLog: () => ipcRenderer.invoke('chat:log:all'),
  onChatLog: (cb) => ipcRenderer.on('chat:log', (_e, data) => cb(data)),
  // 人设
  personaGet: () => ipcRenderer.invoke('persona:get'),
  personaSet: (patch) => ipcRenderer.invoke('persona:set', patch),
  // 记忆
  memoryGet: () => ipcRenderer.invoke('memory:get'),
  memoryDelete: (ref) => ipcRenderer.invoke('memory:delete', ref),
  moodGet: () => ipcRenderer.invoke('mood:get'),
  moodAdjust: (d) => ipcRenderer.invoke('mood:adjust', d),
  assistantRun: (a) => ipcRenderer.invoke('assistant:run', a),
  dshState: () => ipcRenderer.invoke('dsh:state'),
  vocabList: () => ipcRenderer.invoke('vocab:list'),
  vocabAdd: (w) => ipcRenderer.invoke('vocab:add', w),
  vocabDel: (w) => ipcRenderer.invoke('vocab:del', w),
  vocabReview: (w, ok) => ipcRenderer.invoke('vocab:review', w, ok),
  // 语音（音色）
  ttsVoices: () => ipcRenderer.invoke('tts:voices'),
  ttsSpeak: (payload) => ipcRenderer.invoke('tts:speak', payload),
  artGet: () => ipcRenderer.invoke('art:get'),
  artOpen: () => ipcRenderer.invoke('art:open'),
  artReset: () => ipcRenderer.invoke('art:reset')
});
