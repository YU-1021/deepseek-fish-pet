// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({ request: vi.fn(), showChat: vi.fn(), showPetMenu: vi.fn(), startDrag: vi.fn(), endDrag: vi.fn(), audioPlay: vi.fn(), events: new Set<(frame: any) => void>(), moodEnabled: true }));

vi.mock('./assets/click-duck.wav', () => ({ default: '/click-duck.wav' }));

vi.mock('./petd', () => ({
  usePetdStatus: () => ({ state: 'connected' }),
  request: mocks.request,
  subscribeEvents: (listener: (frame: any) => void) => { mocks.events.add(listener); return () => mocks.events.delete(listener); },
}));

import { App } from './ui';

const snapshot = { mood: 71, affection: 32, energy: 80, pokes: 3, updatedAt: 10, tiers: { mood: '心情不错', affection: '逐渐熟悉', energy: '很正常' } };
function pointerDown(target: Element, pointerId = 1, clientX = 20, clientY = 20) { fireEvent.pointerDown(target, { button: 0, pointerId, clientX, clientY }); }
function pointerUp(target: Element, pointerId = 1, clientX = 20, clientY = 20) { fireEvent.pointerUp(target, { button: 0, pointerId, clientX, clientY }); }

beforeEach(() => {
  cleanup(); localStorage.clear(); mocks.events.clear(); mocks.showChat.mockReset(); mocks.showPetMenu.mockReset(); mocks.startDrag.mockReset(); mocks.endDrag.mockReset(); mocks.request.mockReset();
  mocks.audioPlay.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal('Audio', class { currentTime = 0; volume = 1; play = mocks.audioPlay; });
  mocks.moodEnabled = true;
  window.history.replaceState({}, '', '/?pet=1');
  Object.defineProperty(window, 'petdBootstrap', { configurable: true, value: { showChat: mocks.showChat, showPetMenu: mocks.showPetMenu, startDrag: mocks.startDrag, endDrag: mocks.endDrag } });
  mocks.request.mockImplementation(async (method: string) => {
    if (method === 'mood.status') return { enabled: mocks.moodEnabled, state: snapshot };
    if (method === 'mood.history') return { entries: [] };
    if (method === 'mood.poke') return { ...snapshot, mood: 72, pokes: 4 };
    return {};
  });
});

afterEach(() => { window.history.replaceState({}, '', '/'); cleanup(); });

describe('PetOverlay mood interaction', () => {
  it('pokes once on a single click while keeping the pet window artwork-only', async () => {
    render(<App/>);
    await screen.findByLabelText('蓝色大肥鱼女仆，待机呼吸动画');
    const pet = screen.getByTitle('点一下摸摸 · 双击打开聊天 · 右键菜单');
    const artwork = pet.querySelector('.pet-float')!;
    pointerDown(artwork); pointerUp(artwork);
    await waitFor(() => expect(mocks.request).toHaveBeenCalledWith('mood.poke', {}), { timeout: 1000 });
    expect(mocks.startDrag).toHaveBeenCalledTimes(1);
    expect(mocks.endDrag).toHaveBeenCalledTimes(1);
    expect(pet.querySelector('.pet-bounce')).toBeTruthy();
    expect(mocks.audioPlay).toHaveBeenCalledTimes(1);
    expect(pet.querySelector('.pet-face, .pet-mood-rings, .pet-heart, .pet-hint')).toBeNull();
    expect(pet.textContent).toBe('');
  });

  it('opens chat on double-click without poking', async () => {
    render(<App/>);
    await screen.findByLabelText('蓝色大肥鱼女仆，待机呼吸动画');
    const pet = screen.getByTitle('点一下摸摸 · 双击打开聊天 · 右键菜单');
    const artwork = pet.querySelector('.pet-float')!;
    pointerDown(artwork); pointerUp(artwork);
    pointerDown(artwork); pointerUp(artwork);
    fireEvent.doubleClick(pet, { detail: 2 });
    expect(mocks.showChat).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => window.setTimeout(resolve, 300));
    expect(mocks.request).not.toHaveBeenCalledWith('mood.poke', {});
    expect(mocks.audioPlay).not.toHaveBeenCalled();
  });

  it('does not poke when mood is disabled', async () => {
    mocks.moodEnabled = false;
    render(<App/>);
    const pet = screen.getByTitle('点一下摸摸 · 双击打开聊天 · 右键菜单');
    const artwork = pet.querySelector('.pet-float')!;
    pointerDown(artwork); pointerUp(artwork);
    await new Promise((resolve) => window.setTimeout(resolve, 300));
    expect(mocks.request).not.toHaveBeenCalledWith('mood.poke', {});
    expect(pet.querySelector('.pet-bounce')).toBeTruthy();
    expect(mocks.audioPlay).toHaveBeenCalledTimes(1);
  });

  it('moves the pet without treating a drag as a poke', async () => {
    render(<App/>);
    await screen.findByLabelText('蓝色大肥鱼女仆，待机呼吸动画');
    const pet = screen.getByTitle('点一下摸摸 · 双击打开聊天 · 右键菜单');
    const artwork = pet.querySelector('.pet-float')!;
    pointerDown(artwork, 2, 20, 20);
    fireEvent.pointerMove(artwork, { pointerId: 2, clientX: 40, clientY: 20 });
    pointerUp(artwork, 2, 40, 20);
    await new Promise((resolve) => window.setTimeout(resolve, 300));
    expect(mocks.startDrag).toHaveBeenCalledTimes(1);
    expect(mocks.endDrag).toHaveBeenCalledTimes(1);
    expect(mocks.request).not.toHaveBeenCalledWith('mood.poke', {});
    expect(mocks.audioPlay).not.toHaveBeenCalled();
  });

  it('does not show chat mood changes on the pet artwork', async () => {
    render(<App/>);
    await screen.findByLabelText('蓝色大肥鱼女仆，待机呼吸动画');
    act(() => { for (const listener of mocks.events) listener({ type: 'event', event: 'mood.changed', data: { state: snapshot, applied: [], source: 'chat' } }); });
    const pet = screen.getByTitle('点一下摸摸 · 双击打开聊天 · 右键菜单');
    expect(pet.textContent).toBe('');
    expect(pet.classList.contains('pet-chat-nudge')).toBe(false);
  });
});
