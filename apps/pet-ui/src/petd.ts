import { useSyncExternalStore } from 'react';

type Frame = { type: string; [key: string]: any };
type Snapshot = { state: 'connecting' | 'connected' | 'offline'; version?: string; methodCount?: number; gatewayPort?: number; error?: string };
const listeners = new Set<() => void>();
const events = new Set<(frame: Frame) => void>();
let snapshot: Snapshot = { state: 'connecting' };
let socket: WebSocket | undefined;
let requestId = 0;
let retry = 0;
declare global { interface Window { petdBootstrap?: { read: () => Promise<{ port?: number; token?: string; version?: string; error?: string }>; showChat: () => Promise<void> } } }
const pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: number }>();
const publish = (next: Snapshot) => { snapshot = next; listeners.forEach((fn) => fn()); };
const delays = [1000, 2000, 5000];

function connect() {
  publish({ state: 'connecting' });
  if (!window.petdBootstrap) { scheduleReconnect('请在 Electron 桌面窗口中运行'); return; }
  window.petdBootstrap.read().then((bootstrap) => {
    if (!bootstrap.port || !bootstrap.token) throw new Error(bootstrap.error ?? 'petd 尚未启动，找不到 gateway.json');
    socket = new WebSocket(`ws://127.0.0.1:${bootstrap.port}`);
    socket.onopen = () => socket?.send(JSON.stringify({ type: 'connect', protocol: 1, token: bootstrap.token, client: { name: 'pet-ui', version: '0.1.0', pid: 1 } }));
    socket.onmessage = (message) => {
      const frame = JSON.parse(String(message.data)) as Frame;
      if (frame.type === 'hello') {
        retry = 0;
        publish({ state: 'connected' });
        void request('health.status', {}).then((status) => publish({ state: 'connected', version: status.server.version, methodCount: status.methods.length, gatewayPort: status.gateway.port })).catch((error: Error) => publish({ state: 'offline', error: `已握手，但读取状态失败：${error.message}` }));
      } else if (frame.type === 'res') {
        const task = pending.get(frame.id);
        if (!task) return;
        window.clearTimeout(task.timer); pending.delete(frame.id);
        if (frame.ok) task.resolve(frame.data);
        else task.reject(Object.assign(new Error(frame.error?.message ?? 'petd 请求失败'), { code: frame.error?.code }));
      } else if (frame.type === 'event') events.forEach((listener) => listener(frame));
    };
    socket.onclose = (event) => {
      for (const task of pending.values()) { window.clearTimeout(task.timer); task.reject(new Error('petd 连接已断开')); }
      pending.clear();
      const reason = event.reason ? `：${event.reason}` : '';
      scheduleReconnect(`连接已断开（${event.code}${reason}）`);
    };
    socket.onerror = () => publish({ state: 'offline', error: '无法连接 petd，请检查服务是否启动' });
  }).catch((error: Error) => scheduleReconnect(error.message));
}
function scheduleReconnect(error: string) {
  publish({ state: 'offline', error });
  window.setTimeout(connect, delays[Math.min(retry++, delays.length - 1)]);
}
export function request(method: string, params: unknown, timeout = 120000): Promise<any> {
  if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('petd 尚未连接'));
  const id = String(++requestId);
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => { pending.delete(id); reject(new Error('请求超时')); }, timeout);
    pending.set(id, { resolve, reject, timer });
    socket!.send(JSON.stringify({ type: 'req', id, method, params }));
  });
}
export function subscribeEvents(listener: (frame: Frame) => void) { events.add(listener); return () => events.delete(listener); }
export function usePetdStatus() { return useSyncExternalStore((listener) => { listeners.add(listener); return () => listeners.delete(listener); }, () => snapshot); }
if (!new URLSearchParams(window.location.search).has('pet')) connect();
