// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({ request: vi.fn(), showChat: vi.fn(), showPetMenu: vi.fn(), events: new Set<(frame: any) => void>(), moodEnabled: true }));

vi.mock('./petd', () => ({
  usePetdStatus: () => ({ state: 'connected' }),
  request: mocks.request,
  subscribeEvents: (listener: (frame: any) => void) => { mocks.events.add(listener); return () => mocks.events.delete(listener); },
}));

import { App } from './ui';

const snapshot = { mood: 71, affection: 32, energy: 80, pokes: 3, updatedAt: 10, tiers: { mood: '心情不错', affection: '逐渐熟悉', energy: '很正常' } };

beforeEach(() => {
  cleanup(); localStorage.clear(); mocks.events.clear(); mocks.showChat.mockReset(); mocks.showPetMenu.mockReset(); mocks.request.mockReset();
  mocks.moodEnabled = true;
  window.history.replaceState({}, '', '/?pet=1');
  Object.defineProperty(window, 'petdBootstrap', { configurable: true, value: { showChat: mocks.showChat, showPetMenu: mocks.showPetMenu } });
  mocks.request.mockImplementation(async (method: string) => {
    if (method === 'mood.status') return { enabled: mocks.moodEnabled, state: snapshot };
    if (method === 'mood.history') return { entries: [] };
    if (method === 'mood.poke') return { ...snapshot, mood: 72, pokes: 4 };
    return {};
  });
});

afterEach(() => { window.history.replaceState({}, '', '/'); cleanup(); });

describe('PetOverlay mood interaction', () => {
  it('pokes once on a single click and shows short feedback', async () => {
    render(<App/>);
    await screen.findByText('😊');
    const pet = screen.getByTitle('点一下摸摸 · 双击打开聊天 · 右键菜单');
    fireEvent.click(pet);
    await waitFor(() => expect(mocks.request).toHaveBeenCalledWith('mood.poke', {}), { timeout: 1000 });
    expect(pet.classList.contains('pet-feedback')).toBe(true);
    expect(screen.getByText('♥')).toBeTruthy();
  });

  it('opens chat on double-click without poking', async () => {
    render(<App/>);
    await screen.findByText('😊');
    const pet = screen.getByTitle('点一下摸摸 · 双击打开聊天 · 右键菜单');
    fireEvent.click(pet, { detail: 1 });
    fireEvent.click(pet, { detail: 2 });
    fireEvent.doubleClick(pet, { detail: 2 });
    expect(mocks.showChat).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => window.setTimeout(resolve, 300));
    expect(mocks.request).not.toHaveBeenCalledWith('mood.poke', {});
  });

  it('does not poke when mood is disabled', async () => {
    mocks.moodEnabled = false;
    render(<App/>);
    const pet = screen.getByTitle('点一下摸摸 · 双击打开聊天 · 右键菜单');
    fireEvent.click(pet);
    await new Promise((resolve) => window.setTimeout(resolve, 300));
    expect(mocks.request).not.toHaveBeenCalledWith('mood.poke', {});
  });

  it('uses a subtle class when chat mood changes arrive', async () => {
    render(<App/>);
    await screen.findByText('😊');
    act(() => { for (const listener of mocks.events) listener({ type: 'event', event: 'mood.changed', data: { state: snapshot, applied: [], source: 'chat' } }); });
    expect(screen.getByTitle('点一下摸摸 · 双击打开聊天 · 右键菜单').classList.contains('pet-chat-nudge')).toBe(true);
  });
});
