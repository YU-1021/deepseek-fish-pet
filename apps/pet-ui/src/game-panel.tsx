import { useEffect, useState } from 'react';
import { request, usePetdStatus } from './petd';
import './game-panel.css';

const errorText = (error: any) =>
  error?.code === 'E_UNAVAILABLE'
    ? '游戏助手未启用，或没找到预习助手 / 桥脚本（config.game.assistantDir）。'
    : error?.code === 'E_FORBIDDEN'
      ? '真点开关（config.game.allowClick）没开，这一次只做计划、没有真的点。'
      : error?.code === 'E_INTERNAL'
        ? '调用游戏助手失败或超时，请确认游戏窗口可见、没有被别的窗口挡住。'
        : error?.message ?? '操作失败，请重试。';

const boxText = (box: any) => (box ? `(x ${box.x}, y ${box.y}, ${box.w}×${box.h})` : '—');

export function GameSettingsPanel({ config }: { config: any }) {
  const connection = usePetdStatus();
  const [status, setStatus] = useState<any>(null);
  const [look, setLook] = useState<any>(null);
  const [shot, setShot] = useState('');
  const [findText, setFindText] = useState('理智');
  const [findResult, setFindResult] = useState<any>(null);
  const [x, setX] = useState('640');
  const [y, setY] = useState('360');
  const [confirmReal, setConfirmReal] = useState(false);
  const [clickResult, setClickResult] = useState<any>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function refresh() {
    if (connection.state !== 'connected') return;
    try {
      setStatus(await request('game.status', {}));
      setError('');
    } catch (cause) {
      setError(errorText(cause));
    }
  }

  useEffect(() => {
    void refresh();
  }, [connection.state]);

  async function runLook() {
    setBusy('look');
    setError('');
    setNotice('');
    setFindResult(null);
    setClickResult(null);
    setShot('');
    try {
      const names = ['理智', '剩余可放置角色', findText.trim()].filter((value, index, all) => !!value && all.indexOf(value) === index);
      const result = await request('game.look', { find: names, ocrEngine: 'paddle' }, 90_000);
      setLook(result);
      if (result?.capture?.png) {
        try {
          setShot((await window.petdBootstrap?.readGameCapture?.(result.capture.png)) ?? '');
        } catch {
          setShot('');
        }
      }
      if (!result?.ok) setError(result?.error ?? '抓帧失败');
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy('');
    }
  }

  async function runFind() {
    if (!findText.trim()) return;
    setBusy('find');
    setError('');
    setNotice('');
    try {
      const result = await request('game.find', { text: findText.trim(), minCoverage: 0.6 }, 90_000);
      setFindResult(result);
      if (!result?.found) setNotice('这一帧里没找到，可能不在这个界面，或者游戏被挡住了。');
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy('');
    }
  }

  async function runClick(real: boolean) {
    setBusy('click');
    setError('');
    setNotice('');
    try {
      const result = await request('game.click', { x: Number(x), y: Number(y), real }, 90_000);
      setClickResult(result);
      if (result?.dryRun) setNotice('这是预演，没有真的点。要真点，先在配置里打开 allowClick，再勾选下面的确认。');
      else if (result?.ok) setNotice('已经点下去了。');
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy('');
    }
  }

  const game = config ?? {};
  const allowClick = !!game.allowClick;
  const connected = connection.state === 'connected';
  const disabled = !connected || busy !== '';

  return (
    <section className="game-panel">
      <div className="game-heading">
        <div>
          <span className="eyebrow">ARKNIGHTS</span>
          <h3>游戏助手（Aknight.gmaer）</h3>
        </div>
        <span className={`game-state ${game.enabled ? 'on' : ''}`}>{game.enabled ? '已启用' : '未启用'}</span>
      </div>
      <p className="game-danger-note">
        游戏助手通过预习助手用 MAA 抓游戏画面再识别，默认只做预演不点击。真点需要配置里 <code>game.allowClick</code> 为 true，并且每次确认；游戏被浏览器等窗口完全挡住时抓到的会是遮挡窗口。
      </p>
      {error && <p className="game-error" role="alert">{error}</p>}
      {notice && <p className="game-notice" role="status">{notice}</p>}
      <div className="game-values">
        <div><span>游戏窗口</span><strong>{status?.window ? `${status.window.title} · ${status.window.w}×${status.window.h}` : status ? '没找到（游戏没开？）' : '读取中…'}</strong></div>
        <div><span>预习助手</span><strong>{status?.assistantDir ?? game.assistantDir ?? '—'}</strong></div>
        <div><span>桥脚本</span><strong>{status?.bridgePath ?? '—'}</strong></div>
        <div><span>点击开关</span><strong>{allowClick ? '允许真点（每次确认）' : '只读 · 只预演'}</strong></div>
        <div><span>调用统计</span><strong>{status?.counters ? `${status.counters.ok} 成功 / ${status.counters.errors} 失败 / 共 ${status.counters.calls}` : '—'}</strong></div>
        <div><span>最近错误</span><strong>{status?.lastError ?? '无'}</strong></div>
      </div>
      <div className="game-actions">
        <button onClick={() => void refresh()} disabled={!connected}>刷新状态</button>
        <button onClick={() => void runLook()} disabled={disabled}>{busy === 'look' ? '看屏识别中…' : '看屏 + 识别'}</button>
      </div>
      {look && (
        <div className="game-preview">
          <div className="game-preview-head">
            <strong>{look.game?.title ?? '游戏画面'}</strong>
            <button onClick={() => { setLook(null); setShot(''); }}>清除预览</button>
          </div>
          {shot ? <img src={shot} alt="游戏画面预览" /> : <p className="game-muted">没拿到截图（可能抓帧失败）。</p>}
          <small>
            画面 {look.capture?.w ?? '—'}×{look.capture?.h ?? '—'} · 黑边 {(look.capture?.blackRatio ?? 0).toFixed?.(3) ?? look.capture?.blackRatio ?? '—'} · OCR {look.ocr?.lineCount ?? 0} 行
          </small>
          {look.find?.length ? (
            <ul className="game-finds">
              {look.find.map((hit: any) => (
                <li key={hit.text}>
                  <span>{hit.text}</span>
                  <strong>{Math.round((hit.coverage ?? 0) * 100)}%</strong>
                  <small>{boxText(hit.box)}</small>
                </li>
              ))}
            </ul>
          ) : null}
          {look.ocr?.text && <pre className="game-ocr">{look.ocr.text}</pre>}
        </div>
      )}
      <div className="game-tool-row">
        <label>
          <span>找字</span>
          <input value={findText} onChange={(event) => setFindText(event.target.value)} placeholder="例如：开始行动" />
        </label>
        <button onClick={() => void runFind()} disabled={disabled || !findText.trim()}>{busy === 'find' ? '找字中…' : '在当前画面找'}</button>
      </div>
      {findResult && (
        <p className="game-find-result">
          {findResult.found ? `找到了，覆盖率 ${Math.round((findResult.coverage ?? 0) * 100)}%，位置 ${boxText(findResult.box)}` : `没找到（覆盖率 ${Math.round((findResult.coverage ?? 0) * 100)}%）。`}
        </p>
      )}
      <div className="game-tool-row game-click-row">
        <label><span>X</span><input value={x} onChange={(event) => setX(event.target.value)} inputMode="numeric" /></label>
        <label><span>Y</span><input value={y} onChange={(event) => setY(event.target.value)} inputMode="numeric" /></label>
        <button onClick={() => void runClick(false)} disabled={disabled}>{busy === 'click' ? '处理中…' : '预演点击'}</button>
        <button
          className="game-real-click"
          onClick={() => void runClick(true)}
          disabled={disabled || !allowClick || !confirmReal}
          title={allowClick ? '勾选确认后才能真点' : '配置里 game.allowClick 为 false'}
        >
          真点
        </button>
      </div>
      <label className="game-real-confirm">
        <input type="checkbox" checked={confirmReal} onChange={(event) => setConfirmReal(event.target.checked)} />
        <span>我确认这次会真的点击游戏（坐标 {x},{y}）</span>
      </label>
      {clickResult && (
        <p className="game-find-result">
          {clickResult.dryRun ? `预演：将点 (${clickResult.planned?.x}, ${clickResult.planned?.y})，没有真的点。` : clickResult.ok ? `已点击 (${clickResult.x}, ${clickResult.y})。` : `点击失败：${clickResult.error ?? '未知'}`}
        </p>
      )}
    </section>
  );
}
