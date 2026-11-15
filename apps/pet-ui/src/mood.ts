import { useCallback, useEffect, useRef, useState } from 'react';
import { request, subscribeEvents, usePetdStatus } from './petd';

export type MoodState = {
  mood: number;
  affection: number;
  energy: number;
  pokes: number;
  updatedAt: number;
  tiers: { mood: string; affection: string; energy: string };
};
export type MoodEntry = { ts: number; key: 'mood' | 'affection' | 'energy'; from: number; to: number; delta: number; reason: string; source: string };
type MoodFrame = { type: string; event?: string; data?: { state?: MoodState; applied?: MoodEntry[]; source?: string } };
export type MoodChange = { source: string; at: number } | null;
const moodNumbersKey = 'pet-ui.show-mood-values';

export function useMoodNumberPreference(): [boolean, (show: boolean) => void] {
  const [showValues, setShowValues] = useState(() => window.localStorage.getItem(moodNumbersKey) === 'true');
  useEffect(() => {
    const onStorage = (event: StorageEvent) => { if (event.key === moodNumbersKey) setShowValues(event.newValue === 'true'); };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  const update = useCallback((show: boolean) => {
    setShowValues(show);
    window.localStorage.setItem(moodNumbersKey, String(show));
  }, []);
  return [showValues, update];
}

export function moodErrorText(error: any): string {
  if (error?.code === 'E_INTERNAL') return '这次没想明白，等会儿再试';
  if (error?.code === 'E_UNAVAILABLE') return '服务暂时不可用，请稍后重试。';
  if (error?.code === 'E_TIMEOUT') return '请求超时，请稍后重试。';
  return error?.message || '读取情绪状态失败，请稍后重试。';
}

export function useMoodState() {
  const connection = usePetdStatus();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [state, setState] = useState<MoodState | null>(null);
  const [history, setHistory] = useState<MoodEntry[]>([]);
  const [error, setError] = useState('');
  const [lastChange, setLastChange] = useState<MoodChange>(null);
  const applySnapshot = useCallback((snapshot: MoodState) => setState(snapshot), []);
  const eventVersionRef = useRef(0);

  const refresh = useCallback(async () => {
    const eventVersion = eventVersionRef.current;
    const status = await request('mood.status', {});
    if (eventVersion === eventVersionRef.current) {
      setEnabled(Boolean(status.enabled));
      setState(status.state as MoodState);
    }
    const recent = await request('mood.history', { limit: 8 });
    if (eventVersion === eventVersionRef.current) setHistory(recent.entries as MoodEntry[]);
    setError('');
  }, []);

  useEffect(() => {
    if (connection.state !== 'connected') return;
    let active = true;
    const unsubscribe = subscribeEvents((frame: MoodFrame) => {
      if (frame.type !== 'event' || frame.event !== 'mood.changed' || !frame.data?.state) return;
      eventVersionRef.current += 1;
      setState(frame.data.state);
      setLastChange({ source: frame.data.source ?? 'system', at: Date.now() });
      if (Array.isArray(frame.data.applied) && frame.data.applied.length) {
        setHistory((items) => [...frame.data!.applied!, ...items].filter((item, index, all) => all.findIndex((candidate) => candidate.ts === item.ts && candidate.key === item.key) === index).sort((a, b) => b.ts - a.ts).slice(0, 8));
      } else {
        void request('mood.history', { limit: 8 }).then((recent) => { if (active) setHistory(recent.entries as MoodEntry[]); }).catch(() => {});
      }
    });
    void refresh().catch((cause) => { if (active) setError(moodErrorText(cause)); });
    return () => { active = false; unsubscribe(); };
  }, [connection.state, refresh]);

  return { enabled, state, history, error, lastChange, refresh, applySnapshot };
}
