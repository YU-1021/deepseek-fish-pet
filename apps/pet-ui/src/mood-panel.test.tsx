// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  events: new Set<(frame: any) => void>(),
  connection: { state: 'connected' as 'connected' | 'offline' | 'connecting' },
}));

vi.mock('./petd', () => ({
  usePetdStatus: () => mocks.connection,
  request: mocks.request,
  subscribeEvents: (listener: (frame: any) => void) => { mocks.events.add(listener); return () => mocks.events.delete(listener); },
}));

import { MoodSettingsPanel } from './mood-panel';

const moodState = { mood: 71, affection: 32, energy: 80, pokes: 3, updatedAt: 10, tiers: { mood: '心情不错', affection: '逐渐熟悉', energy: '很正常' } };
const config = { mood: { enabled: true, chatInjection: true, chatNudge: true, moodDecayPerHour: 2, energyRecoverPerHour: 8 } };
const applied = [{ ts: 11, key: 'mood', from: 71, to: 72, delta: 1, reason: '聊得很开心', source: 'llm' }];

beforeEach(() => {
  cleanup(); mocks.events.clear(); mocks.connection.state = 'connected';
  mocks.request.mockReset();
  mocks.request.mockImplementation(async (method: string) => {
    if (method === 'mood.status') return { enabled: true, state: moodState };
    if (method === 'mood.history') return { entries: [] };
    if (method === 'mood.evaluate') return { state: moodState, applied };
    return {};
  });
});

describe('MoodSettingsPanel', () => {
  it('shows petd tiers and hides exact values by default', async () => {
    render(<MoodSettingsPanel config={config} sessionId="s-1" showValues={false} onShowValuesChange={() => {}}/>);
    expect(await screen.findByText('心情不错')).toBeTruthy();
    expect(screen.getByText('逐渐熟悉')).toBeTruthy();
    expect(screen.queryByText('71 / 100')).toBeNull();
    expect(screen.getByText('聊天后轻微变化：开启')).toBeTruthy();
  });

  it('lets the settings debug toggle reveal exact values', async () => {
    const { rerender } = render(<MoodSettingsPanel config={config} sessionId="s-1" showValues={false} onShowValuesChange={() => rerender(<MoodSettingsPanel config={config} sessionId="s-1" showValues onShowValuesChange={() => {}}/>)}/>);
    await screen.findByText('心情不错');
    fireEvent.click(screen.getByLabelText('显示精确数值（调试）'));
    expect(screen.getByText('71 / 100')).toBeTruthy();
  });

  it('hides mood actions when petd reports mood disabled', async () => {
    mocks.request.mockImplementation(async (method: string) => method === 'mood.status' ? { enabled: false, state: moodState } : { entries: [] });
    render(<MoodSettingsPanel config={{ mood: { ...config.mood, enabled: false } }} sessionId="s-1" showValues={false} onShowValuesChange={() => {}}/>);
    expect(await screen.findByText('情绪系统已关闭')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '让它想想刚才聊得怎么样' })).toBeNull();
  });

  it('locks the evaluate button until the response and shows applied hints', async () => {
    let resolveEvaluate!: (value: unknown) => void;
    mocks.request.mockImplementation(async (method: string) => {
      if (method === 'mood.status') return { enabled: true, state: moodState };
      if (method === 'mood.history') return { entries: [] };
      if (method === 'mood.evaluate') return new Promise((resolve) => { resolveEvaluate = resolve; });
      return {};
    });
    render(<MoodSettingsPanel config={config} sessionId="s-1" showValues={false} onShowValuesChange={() => {}}/>);
    const button = await screen.findByRole('button', { name: '让它想想刚才聊得怎么样' });
    fireEvent.click(button);
    expect(screen.getByRole('button', { name: '正在想…' }).hasAttribute('disabled')).toBe(true);
    expect(mocks.request).toHaveBeenCalledWith('mood.evaluate', { sessionId: 's-1' }, 90000);
    await act(async () => resolveEvaluate({ state: moodState, applied }));
    expect(await screen.findByText('心情 +1（聊得很开心）')).toBeTruthy();
    expect(screen.getByRole('button', { name: '让它想想刚才聊得怎么样' }).hasAttribute('disabled')).toBe(false);
  });

  it('shows the specified friendly E_INTERNAL message', async () => {
    mocks.request.mockImplementation(async (method: string) => {
      if (method === 'mood.status') return { enabled: true, state: moodState };
      if (method === 'mood.history') return { entries: [] };
      throw Object.assign(new Error('provider details'), { code: 'E_INTERNAL' });
    });
    render(<MoodSettingsPanel config={config} sessionId="s-1" showValues={false} onShowValuesChange={() => {}}/>);
    fireEvent.click(await screen.findByRole('button', { name: '让它想想刚才聊得怎么样' }));
    expect(await screen.findByText('这次没想明白，等会儿再试')).toBeTruthy();
  });

  it('updates its view from the shared mood.changed event', async () => {
    render(<MoodSettingsPanel config={config} sessionId="s-1" showValues onShowValuesChange={() => {}}/>);
    await screen.findByText('心情不错');
    act(() => { for (const listener of mocks.events) listener({ type: 'event', event: 'mood.changed', data: { state: { ...moodState, mood: 75 }, applied: [], source: 'chat' } }); });
    expect(await screen.findByText('75 / 100')).toBeTruthy();
  });
});
