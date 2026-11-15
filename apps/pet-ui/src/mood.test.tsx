// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  events: new Set<(frame: any) => void>(),
  status: { state: 'connected' as 'connected' | 'offline' | 'connecting' },
}));

vi.mock('./petd', () => ({
  usePetdStatus: () => mocks.status,
  request: mocks.request,
  subscribeEvents: (listener: (frame: any) => void) => { mocks.events.add(listener); return () => mocks.events.delete(listener); },
}));

import { useMoodNumberPreference, useMoodState } from './mood';

const snapshot = (mood = 71) => ({ mood, affection: 32, energy: 80, pokes: 3, updatedAt: 10, tiers: { mood: '心情不错', affection: '逐渐熟悉', energy: '很正常' } });

function Harness() {
  const mood = useMoodState();
  return <div>
    <span>{mood.enabled === null ? '未读取' : mood.enabled ? '已启用' : '已关闭'}</span>
    <span>{mood.state?.tiers.mood ?? '无档位'}</span>
    <span>{mood.state?.mood ?? '无数值'}</span>
    <span>{mood.history.length} 条历史</span>
  </div>;
}

function PreferenceHarness() {
  const [showValues, setShowValues] = useMoodNumberPreference();
  return <label><input type="checkbox" aria-label="数值" checked={showValues} onChange={(event) => setShowValues(event.target.checked)}/>{showValues ? '数值显示' : '数值隐藏'}</label>;
}

beforeEach(() => {
  cleanup();
  localStorage.clear();
  mocks.events.clear();
  mocks.status.state = 'connected';
  mocks.request.mockReset();
  mocks.request.mockImplementation(async (method: string) => {
    if (method === 'mood.status') return { enabled: true, state: snapshot() };
    if (method === 'mood.history') return { entries: [{ ts: 9, key: 'mood', from: 70, to: 71, delta: 1, reason: '刚聊天', source: 'chat' }] };
    return {};
  });
});

describe('mood state subscription', () => {
  it('connects to mood.status and loads recent history', async () => {
    render(<Harness/>);
    expect(await screen.findByText('已启用')).toBeTruthy();
    expect(screen.getByText('心情不错')).toBeTruthy();
    expect(await screen.findByText('1 条历史')).toBeTruthy();
    expect(mocks.request.mock.calls.map(([method]) => method)).toEqual(['mood.status', 'mood.history']);
  });

  it('refreshes status once after a disconnect and reconnect', async () => {
    const { rerender } = render(<Harness/>);
    await screen.findByText('已启用');
    mocks.status.state = 'offline'; rerender(<Harness/>);
    mocks.status.state = 'connected'; rerender(<Harness/>);
    await screen.findByText('1 条历史');
    await vi.waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(4));
    expect(mocks.request.mock.calls.map(([method]) => method)).toEqual(['mood.status', 'mood.history', 'mood.status', 'mood.history']);
  });

  it('applies mood.changed snapshots and history without polling', async () => {
    render(<Harness/>);
    await screen.findByText('已启用');
    act(() => {
      for (const listener of mocks.events) listener({ type: 'event', event: 'mood.changed', data: { state: snapshot(75), applied: [{ ts: 11, key: 'mood', from: 71, to: 75, delta: 4, reason: '被夸了', source: 'poke' }], source: 'poke' } });
    });
    expect(await screen.findByText('75')).toBeTruthy();
    expect(mocks.request.mock.calls.map(([method]) => method)).toEqual(['mood.status', 'mood.history']);
  });

  it('retains a disabled mood state from petd', async () => {
    mocks.request.mockImplementation(async (method: string) => method === 'mood.status' ? { enabled: false, state: snapshot() } : { entries: [] });
    render(<Harness/>);
    expect(await screen.findByText('已关闭')).toBeTruthy();
  });

  it('does not replace a newer event snapshot with a slower initial response', async () => {
    let resolveStatus!: (value: unknown) => void;
    mocks.request.mockImplementation((method: string) => method === 'mood.status' ? new Promise((resolve) => { resolveStatus = resolve; }) : Promise.resolve({ entries: [] }));
    render(<Harness/>);
    act(() => { for (const listener of mocks.events) listener({ type: 'event', event: 'mood.changed', data: { state: snapshot(75), applied: [], source: 'chat' } }); });
    await act(async () => resolveStatus({ enabled: true, state: snapshot(71) }));
    expect(await screen.findByText('75')).toBeTruthy();
  });

  it('persists the debug preference and responds to changes in the other window', async () => {
    render(<PreferenceHarness/>);
    const checkbox = screen.getByLabelText('数值') as HTMLInputElement;
    fireEvent.click(checkbox);
    expect(localStorage.getItem('pet-ui.show-mood-values')).toBe('true');
    expect(screen.getByText('数值显示')).toBeTruthy();
    act(() => window.dispatchEvent(new StorageEvent('storage', { key: 'pet-ui.show-mood-values', newValue: 'false' })));
    expect(screen.getByText('数值隐藏')).toBeTruthy();
  });
});
