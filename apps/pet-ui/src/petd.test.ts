// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

class MockWebSocket {
  static OPEN = 1;
  static instances: MockWebSocket[] = [];
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  sent: string[] = [];
  constructor(readonly url: string) { MockWebSocket.instances.push(this); }
  send(frame: string) { this.sent.push(frame); }
  close() {}
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState({}, '', '/');
  vi.resetModules();
});

describe('pet window petd connection', () => {
  it('connects to petd when opened with the pet query', async () => {
    MockWebSocket.instances = [];
    vi.stubGlobal('WebSocket', MockWebSocket);
    Object.defineProperty(window, 'petdBootstrap', { configurable: true, value: { read: vi.fn(async () => ({ port: 43123, token: 'test-token' })) } });
    window.history.replaceState({}, '', '/?pet=1');

    await import('./petd');
    await vi.waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const socket = MockWebSocket.instances[0]!;
    expect(socket.url).toBe('ws://127.0.0.1:43123');
    socket.onopen?.(new Event('open'));
    expect(JSON.parse(socket.sent[0] ?? '{}')).toMatchObject({ type: 'connect', protocol: 1, token: 'test-token', client: { name: 'pet-ui' } });
  });
});
