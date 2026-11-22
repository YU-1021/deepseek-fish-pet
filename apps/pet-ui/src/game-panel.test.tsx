// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  connection: { state: 'connected' as 'connected' | 'offline' | 'connecting' },
  readCapture: vi.fn(async () => 'data:image/png;base64,AAAA'),
}));

vi.mock('./petd', () => ({
  usePetdStatus: () => mocks.connection,
  request: mocks.request,
}));

import { GameSettingsPanel } from './game-panel';

const config = { game: { enabled: true, assistantDir: 'C:\\deepseek\\预习助手', nodePath: '', timeoutMs: 30000, allowClick: false, gameHint: '明日方舟' } };
const status = {
  enabled: true,
  assistantDir: 'C:\\deepseek\\预习助手',
  bridgePath: 'C:\\deepseek\\预习助手\\tools\\petd-bridge.js',
  nodePath: '',
  allowClick: false,
  gameHint: '明日方舟',
  counters: { calls: 2, ok: 2, errors: 0 },
  lastError: null,
  lastCallAt: 1,
  window: { hwnd: 5311258, title: '明日方舟', proc: 'Arknights', w: 1280, h: 720 },
};
const look = {
  ok: true,
  game: { hwnd: 5311258, title: '明日方舟', proc: 'Arknights', w: 1280, h: 720 },
  capture: { w: 1280, h: 720, png: 'C:\\tmp\\capture.png', blackRatio: 0.019, brightness: 0.6, at: 1 },
  ocr: { engine: 'paddle', ok: true, text: '理智 46/50', lineCount: 1 },
  find: [{ text: '理智', coverage: 1, box: { x: 10, y: 20, w: 60, h: 20 } }],
};

beforeEach(() => {
  cleanup();
  mocks.connection.state = 'connected';
  mocks.request.mockReset();
  mocks.readCapture.mockClear();
  (globalThis as any).window.petdBootstrap = { readGameCapture: mocks.readCapture };
  mocks.request.mockImplementation(async (method: string, params?: any) => {
    if (method === 'game.status') return status;
    if (method === 'game.look') return look;
    if (method === 'game.find') return { ok: true, found: true, coverage: 0.92, box: { x: 600, y: 300, w: 100, h: 30 } };
    if (method === 'game.click') return params?.real ? { ok: true, x: params.x, y: params.y } : { ok: true, dryRun: true, planned: { x: params?.x, y: params?.y } };
    return {};
  });
});

describe('GameSettingsPanel', () => {
  it('shows game status and keeps the real-click button locked when allowClick is false', async () => {
    render(<GameSettingsPanel config={config.game} />);
    expect(await screen.findByText('明日方舟 · 1280×720')).toBeTruthy();
    expect(screen.getByText('只读 · 只预演')).toBeTruthy();
    const real = screen.getByText('真点') as HTMLButtonElement;
    expect(real.disabled).toBe(true);
  });

  it('looks at the screen, shows the capture image and find results', async () => {
    render(<GameSettingsPanel config={config.game} />);
    fireEvent.click(await screen.findByText('看屏 + 识别'));
    await waitFor(() => expect(mocks.request).toHaveBeenCalledWith('game.look', expect.objectContaining({ ocrEngine: 'paddle' }), 90_000));
    expect(await screen.findByAltText('游戏画面预览')).toBeTruthy();
    expect(mocks.readCapture).toHaveBeenCalledWith('C:\\tmp\\capture.png');
    expect(screen.getByText('理智')).toBeTruthy();
    expect(screen.getByText('OCR 1 行', { exact: false })).toBeTruthy();
  });

  it('reports a successful find with coverage and position', async () => {
    render(<GameSettingsPanel config={config.game} />);
    fireEvent.click(await screen.findByText('在当前画面找'));
    expect(await screen.findByText(/找到了，覆盖率 92%/)).toBeTruthy();
    expect(screen.getByText(/x 600, y 300, 100×30/)).toBeTruthy();
  });

  it('requires the confirm checkbox before a real click and sends real:true', async () => {
    const allow = { ...config.game, allowClick: true };
    mocks.request.mockImplementation(async (method: string, params: any) => {
      if (method === 'game.status') return { ...status, allowClick: true };
      if (method === 'game.click') return params?.real ? { ok: true, x: params.x, y: params.y } : { ok: true, dryRun: true, planned: { x: params.x, y: params.y } };
      return {};
    });
    render(<GameSettingsPanel config={allow} />);
    const real = screen.getByText('真点') as HTMLButtonElement;
    expect(real.disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(real.disabled).toBe(false);
    fireEvent.click(real);
    await waitFor(() => expect(mocks.request).toHaveBeenCalledWith('game.click', expect.objectContaining({ real: true }), 90_000));
    expect(await screen.findByText(/已点击 \(640, 360\)/)).toBeTruthy();
  });

  it('surfaces a friendly error when the assistant is unavailable', async () => {
    mocks.request.mockImplementation(async (method: string) => {
      if (method === 'game.status') return status;
      throw Object.assign(new Error('boom'), { code: 'E_UNAVAILABLE' });
    });
    render(<GameSettingsPanel config={config.game} />);
    fireEvent.click(await screen.findByText('看屏 + 识别'));
    expect(await screen.findByText(/游戏助手未启用/)).toBeTruthy();
  });
});
