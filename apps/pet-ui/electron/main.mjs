import { app, BrowserWindow, ipcMain, Menu, nativeImage, Tray } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
let mainWindow;
let petWindow;
let tray;
function petdHome() {
  if (process.env.PETD_HOME?.trim()) return path.resolve(process.env.PETD_HOME);
  const base = process.env.APPDATA?.trim() || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(base, 'dayu-pet', 'petd');
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
ipcMain.handle('pet:toggle-ignore-mouse', (_event, ignore) => { if (petWindow && !petWindow.isDestroyed()) petWindow.setIgnoreMouseEvents(Boolean(ignore), { forward: true }); });
ipcMain.handle('pet:show-chat', () => { mainWindow?.show(); mainWindow?.focus(); });

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1120, height: 760, minWidth: 820, minHeight: 600,
    title: '大肥鱼桌宠', backgroundColor: '#f7f5f1',
    webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  if (process.env.VITE_DEV_SERVER_URL) void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  else void mainWindow.loadFile(path.join(here, '../dist/index.html'));
  petWindow = new BrowserWindow({
    width: 150, height: 150, x: 80, y: 120, frame: false, transparent: true,
    alwaysOnTop: true, resizable: false, skipTaskbar: true, show: true,
    webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  petWindow.setAlwaysOnTop(true, 'screen-saver');
  if (process.env.VITE_DEV_SERVER_URL) void petWindow.loadURL(`${process.env.VITE_DEV_SERVER_URL}?pet=1`);
  else void petWindow.loadFile(path.join(here, '../dist/index.html'), { query: { pet: '1' } });
  petWindow.on('closed', () => { petWindow = undefined; });
  const iconSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" rx="9" fill="#687f62"/><text x="16" y="23" text-anchor="middle" font-size="21">🐟</text></svg>';
  tray = new Tray(nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(iconSvg).toString('base64')}`));
  tray.setToolTip('大肥鱼桌宠');
  let clickThroughEnabled = false;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开聊天面板', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    { label: '显示/隐藏宠物', click: () => { if (!petWindow || petWindow.isDestroyed()) createPetWindow(); else petWindow.isVisible() ? petWindow.hide() : petWindow.show(); } },
    { label: '宠物点击穿透', type: 'checkbox', checked: false, click: (item) => { clickThroughEnabled = item.checked; if (petWindow && !petWindow.isDestroyed()) petWindow.setIgnoreMouseEvents(clickThroughEnabled, { forward: true }); } },
    { type: 'separator' },
    { label: '退出桌宠', click: () => app.quit() },
  ]));
}
function createPetWindow() {
  petWindow = new BrowserWindow({ width: 150, height: 150, x: 80, y: 120, frame: false, transparent: true, alwaysOnTop: true, resizable: false, skipTaskbar: true, show: true, webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  petWindow.setAlwaysOnTop(true, 'screen-saver');
  if (process.env.VITE_DEV_SERVER_URL) void petWindow.loadURL(`${process.env.VITE_DEV_SERVER_URL}?pet=1`); else void petWindow.loadFile(path.join(here, '../dist/index.html'), { query: { pet: '1' } });
  petWindow.on('closed', () => { petWindow = undefined; });
}
app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
