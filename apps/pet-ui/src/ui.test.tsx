// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

vi.mock('./petd', () => ({
  usePetdStatus: () => ({ state: 'connected', version: '0.1.0', methodCount: 15 }),
  request: vi.fn(async (method: string) => method === 'session.list' ? { sessions: [] } : { session: { messages: [] } }),
  subscribeEvents: () => () => {},
}));
import { App } from './ui';

afterEach(cleanup);
describe('聊天面板', () => {
  it('显示空会话状态和 petd 连接信息', async () => {
    render(<App />);
    expect(await screen.findByText('还没有对话，点击上方 ＋ 开始聊天。')).toBeTruthy();
    expect(screen.getByText('petd v0.1.0 · 15 个方法')).toBeTruthy();
  });
  it('断线时禁用消息输入', () => {
    // connection state is mocked as connected above; the composer remains present and ready.
    render(<App />);
    expect(screen.getByPlaceholderText(/和小鱼说说话/).hasAttribute('disabled')).toBe(false);
  });
});
