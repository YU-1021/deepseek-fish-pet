import { app, BrowserWindow, ipcMain, Menu, nativeImage, screen, Tray } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
let mainWindow;
let petWindow;
let tray;
let memoryWorkspace;
const thumbnailCache = new Map();
let petDragTimer;
let petDrag;
const petArtHitRegions = [
  { x: 112, y: 40, width: 56, height: 34 },
  { x: 94, y: 66, width: 92, height: 68 },
  { x: 99, y: 128, width: 82, height: 34 },
  { x: 80, y: 163, width: 120, height: 22 },
];
function applyPetHitRegions(window, height = 190) {
  if (process.platform === 'win32' && typeof window.setShape === 'function') {
    const regions = [...petArtHitRegions];
    if (height > 190) regions.push({ x: 0, y: 168, width: 280, height: height - 168 });
    window.setShape(regions);
  }
}
function petdHome() {
  if (process.env.PETD_HOME?.trim()) return path.resolve(process.env.PETD_HOME);
  const base = process.env.APPDATA?.trim() || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(base, 'dayu-pet', 'petd');
}
function resolveBlobPath(name) {
  if (!memoryWorkspace || typeof name !== 'string' || name === '' || path.basename(name) !== name) throw new Error('附件路径无效');
  const blobRoot = path.resolve(memoryWorkspace, 'blobs');
  const candidate = path.resolve(blobRoot, name);
  if (path.dirname(candidate) !== blobRoot) throw new Error('附件路径超出 blobs 目录');
  const realWorkspace = fs.realpathSync(memoryWorkspace);
  const realRoot = fs.realpathSync(blobRoot);
  if (realRoot !== path.join(realWorkspace, 'blobs')) throw new Error('附件目录不能是工作区外的链接');
  const realFile = fs.realpathSync(candidate);
  const relative = path.relative(realRoot, realFile);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('附件路径超出 blobs 目录');
  return realFile;
}
ipcMain.handle('petd:bootstrap', () => {
  try {
    const home = petdHome();
    const gateway = JSON.parse(fs.readFileSync(path.join(home, 'gateway.json'), 'utf8'));
    const { token } = JSON.parse(fs.readFileSync(path.join(home, 'token.json'), 'utf8'));
    if (!Number.isInteger(gateway.port) || gateway.port < 1 || gateway.port > 65535 || typeof token !== 'string') throw new Error('petd 连接信息无效');
    return { port: gateway.port, token, version: gateway.version };
  } catch (error) {
    return { error: error instanceof Error ? error.message : '无法读取 petd 连接信息' };
  }
});
ipcMain.handle('memory:set-workspace', (_event, workspace) => {
  const expected = path.resolve(petdHome(), 'workspace');
  const candidate = typeof workspace === 'string' ? path.resolve(workspace) : '';
  if (candidate !== expected) throw new Error('petd workspace 路径与本机配置不符');
  memoryWorkspace = expected;
  return true;
});
ipcMain.handle('blob:thumbnail', (_event, input) => {
  const { name, sha256 } = input && typeof input === 'object' ? input : {};
  if (typeof sha256 !== 'string' || !/^[a-f\d]{64}$/i.test(sha256)) throw new Error('附件 SHA-256 无效');
  const blobPath = resolveBlobPath(name);
  const cached = thumbnailCache.get(sha256);
  if (cached) return cached;
  const image = nativeImage.createFromPath(blobPath);
  if (image.isEmpty()) throw new Error('无法读取图片附件');
  const size = image.getSize();
  const scale = Math.min(1, 256 / Math.max(size.width, size.height));
  const dataUrl = image.resize({ width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)), quality: 'good' }).toDataURL();
  thumbnailCache.set(sha256, dataUrl);
  if (thumbnailCache.size > 128) thumbnailCache.delete(thumbnailCache.keys().next().value);
  return dataUrl;
});
ipcMain.handle('blob:file-url', (_event, input) => {
  const { name } = input && typeof input === 'object' ? input : {};
  return pathToFileURL(resolveBlobPath(name)).href;
});
ipcMain.handle('pet:show-chat', () => { mainWindow?.show(); mainWindow?.focus(); });
function dragPetStep() {
  if (!petDrag || !petWindow || petWindow.isDestroyed()) return endPetDrag();
  const cursor = screen.getCursorScreenPoint();
  const x = Math.round(petDrag.windowX + cursor.x - petDrag.cursorX);
  const y = Math.round(petDrag.windowY + cursor.y - petDrag.cursorY);
  const [currentX, currentY] = petWindow.getPosition();
  if (Math.abs(x - currentX) <= 1 && Math.abs(y - currentY) <= 1) return;
  petWindow.setBounds({ ...petDrag.bounds, x, y });
}
function startPetDrag() {
  if (!petWindow || petWindow.isDestroyed()) return;
  endPetDrag();
  const [windowX, windowY] = petWindow.getPosition();
  const cursor = screen.getCursorScreenPoint();
  petDrag = { windowX, windowY, cursorX: cursor.x, cursorY: cursor.y, bounds: petWindow.getBounds() };
  petDragTimer = setInterval(dragPetStep, 8);
}
function endPetDrag() {
  if (petDragTimer) clearInterval(petDragTimer);
  petDragTimer = undefined;
  petDrag = undefined;
}
ipcMain.handle('pet:drag-start', (event) => { if (event.sender === petWindow?.webContents) startPetDrag(); });
ipcMain.handle('pet:drag-end', (event) => { if (event.sender === petWindow?.webContents) endPetDrag(); });
ipcMain.handle('pet:resize', (event, requestedHeight) => {
  if (event.sender !== petWindow?.webContents || !petWindow || petWindow.isDestroyed()) return 190;
  const height = Math.ceil(Math.min(420, Math.max(190, Number(requestedHeight) || 190)));
  const bounds = petWindow.getBounds();
  if (bounds.height !== height) petWindow.setBounds({ ...bounds, height });
  applyPetHitRegions(petWindow, height);
  return height;
});
ipcMain.handle('pet:show-menu', () => {
  if (!petWindow || petWindow.isDestroyed()) return;
  Menu.buildFromTemplate([
    { label: '打开聊天面板', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    { label: '隐藏宠物', click: () => petWindow?.hide() },
    { type: 'separator' },
    { label: '退出桌宠', click: () => app.quit() },
  ]).popup({ window: petWindow });
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1120, height: 760, minWidth: 820, minHeight: 600,
    title: '大肥鱼桌宠', backgroundColor: '#f7f5f1',
    webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  if (process.env.VITE_DEV_SERVER_URL) void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  else void mainWindow.loadFile(path.join(here, '../dist/index.html'));
  petWindow = new BrowserWindow({
    width: 280, height: 190, x: 80, y: 120, frame: false, transparent: true,
    alwaysOnTop: true, resizable: false, skipTaskbar: true, show: true,
    webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  applyPetHitRegions(petWindow);
  petWindow.setAlwaysOnTop(true, 'screen-saver');
  if (process.env.VITE_DEV_SERVER_URL) void petWindow.loadURL(`${process.env.VITE_DEV_SERVER_URL}?pet=1`);
  else void petWindow.loadFile(path.join(here, '../dist/index.html'), { query: { pet: '1' } });
  petWindow.on('closed', () => { endPetDrag(); petWindow = undefined; });
  const iconSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" rx="9" fill="#687f62"/><text x="16" y="23" text-anchor="middle" font-size="21">🐟</text></svg>';
  tray = new Tray(nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(iconSvg).toString('base64')}`));
  tray.setToolTip('大肥鱼桌宠');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开聊天面板', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    { label: '显示/隐藏宠物', click: () => { if (!petWindow || petWindow.isDestroyed()) createPetWindow(); else petWindow.isVisible() ? petWindow.hide() : petWindow.show(); } },
    { type: 'separator' },
    { label: '退出桌宠', click: () => app.quit() },
  ]));
}
function createPetWindow() {
  petWindow = new BrowserWindow({ width: 280, height: 190, x: 80, y: 120, frame: false, transparent: true, alwaysOnTop: true, resizable: false, skipTaskbar: true, show: true, webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  applyPetHitRegions(petWindow);
  petWindow.setAlwaysOnTop(true, 'screen-saver');
  if (process.env.VITE_DEV_SERVER_URL) void petWindow.loadURL(`${process.env.VITE_DEV_SERVER_URL}?pet=1`); else void petWindow.loadFile(path.join(here, '../dist/index.html'), { query: { pet: '1' } });
  petWindow.on('closed', () => { endPetDrag(); petWindow = undefined; });
}
app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
