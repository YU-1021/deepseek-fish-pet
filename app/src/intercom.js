/* 【对讲机 —— 临时测试钩子】
 *
 * 为什么需要：桌宠以管理员权限运行时，外部普通权限的进程（比如我的 AI 会话）
 * 既碰不了她的窗口、也发不了键鼠给她（UIPI 双向）。但她自己的进程有权限 ——
 * 所以在她进程里放一个"读文件 → 当成主人说的话喂给她"的小钩子，
 * 我就能直接跟她对话、把整个任务测完。
 *
 * 协议：%TEMP%\pet-intercom.json 里放 { seq: 递增序号, text: "要对她说的话" }
 *   钩子每 1.5 秒读一次；seq 变了就把 text 通过对话窗渲染层自己的 send() 发给她
 *   （走的就是用户手打那条路：chatSend → 渲染 → 任务循环 → 聊天记录照常写）。
 *   发完把处理过的 seq 记到 %TEMP%\pet-intercom.done 里，避免重复发。
 *
 * 删掉办法：删掉本文件 + main.js 里那两行 install。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const filePath = () => path.join(os.tmpdir(), 'pet-intercom.json');
const donePath = () => path.join(os.tmpdir(), 'pet-intercom.done');
const lockPath = (seq) => path.join(os.tmpdir(), 'pet-intercom.lock-' + seq);

function install(ctx) {
  /* 【进程内只装一次】—— 血泪教训：原来每次热重载都会再 install 一个 setInterval，
     旧的还没退，于是同一条消息被投递 N 次。实测她收到 6 份一模一样的指令、
     聊天记录里连着 6 行同样的话，看起来像"她卡住原地打转"，其实是**我在刷屏**。
     用 global 标记挡住同一进程内的重复安装。

     ⚠️⚠️ 但这个标记**只在同一个进程里有效**。实测（2026-10-02 晚）她又被投递了两次，
     查 debug.log 才发现：`[boot] v0.1.0` 在我改代码期间出现了十几次 —— 应用**不停重启**，
     每次都是**新进程**，global 标记自然失效；而旧的 interval 未必已经退出。
     两个 interval 同时读到 seq=551、同时投递，done 文件也拦不住（它们读到的都是旧值）。
     所以真正可靠的是下面那把**跨进程独占锁**（fs 'wx' 标志：文件已存在就抛错，只有一个赢家）。 */
  if (global.__petIntercomInstalled) { try { ctx.dbg('[intercom] 已经装过了，跳过重复安装'); } catch {} return false; }
  global.__petIntercomInstalled = true;

  const { dbg } = ctx;
  const chatWinOf = () => { try { return typeof ctx.chatWin === 'function' ? ctx.chatWin() : ctx.chatWin; } catch { return null; } };
  let lastSeq = 0;
  try { lastSeq = Number(fs.readFileSync(donePath(), 'utf8')) || 0; } catch {}
  dbg('[intercom] 对讲机已挂上，从 seq=' + lastSeq + ' 开始监听 ' + filePath());

  setInterval(async () => {
    try {
      if (!fs.existsSync(filePath())) return;
      let spec = null;
      try { spec = JSON.parse(fs.readFileSync(filePath(), 'utf8')); } catch { return; }
      const seq = Number(spec && spec.seq) || 0;
      const text = String((spec && spec.text) || '').trim();
      if (!seq || seq <= lastSeq || !text) return;
      /* 【投递前核对 done 文件】多实例并存时把重复压回一次。
         ⚠️ 但**必须在投递成功之后才写 done** —— 我第一版为了抢锁把写入挪到了投递之前，
         结果投递失败（对话窗开不出来等）的消息被永久标记为已完成，再也不会重试
         （实测 seq=290 就是这么丢的）。进程内锁已经解决了竞争，不需要这个顺序。 */
      let doneOnDisk = 0;
      try { doneOnDisk = Number(fs.readFileSync(donePath(), 'utf8')) || 0; } catch {}
      if (doneOnDisk >= seq) { lastSeq = doneOnDisk; return; }
      /* ★ 跨进程独占锁：'wx' 在文件已存在时抛错 —— 谁先建成谁投递，其余一律退出。
         这才真正解决"应用反复重启导致多个 interval 抢同一条"的问题（见上面 install 的注释）。
         投递失败要把锁删掉，否则这条永远没人投（照 seq=290 那次的教训）。

         ★★★ 僵尸锁（2026-10-03 实测踩到）★★★
         抢到锁的那个进程如果**中途死了**（崩溃 / 被 kill / 启动到一半退出），
         锁文件会留在磁盘上，而其它实例看到锁存在就 `lastSeq = seq; return;` ——
         于是**这条消息永远投不出去，而且没有任何提示** ✗（又是"静默失败"）。
         实测现场：pet-intercom.lock-573 留着、持锁 pid 21984 已死、
         她从头到尾没收到那条消息，日志里一个字都没有。
         判据（满足任一即视为僵尸锁，抢过来）：
           · 锁文件存在超过 60 秒
           · 持锁进程已经不存在（process.kill(pid, 0) 抛 ESRCH）
         ⚠️ process.kill(pid, 0) 对"存在但没权限"的进程抛 EPERM —— 那说明它还活着，不算僵尸。 */
      const lock = lockPath(seq);
      let took = false;
      try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx' }); took = true; }
      catch {
        try {
          const st = fs.statSync(lock);
          const holderPid = Number(String(fs.readFileSync(lock, 'utf8')).trim()) || 0;
          const ageMs = Date.now() - st.mtimeMs;
          let alive = false;
          if (holderPid > 0) {
            try { process.kill(holderPid, 0); alive = true; }
            catch (e2) { alive = (e2 && e2.code === 'EPERM'); }   // EPERM = 存在但没权限 → 活着
          }
          /* ★★★ 只有"持锁者已死"或"锁老到不可能是正常投递"才抢 ★★★
             2026-10-03 实测：原判据是 ageMs > 60000 || !alive —— 60 秒就抢 ✗，
             **哪怕持锁进程还活着** ✓。日志里留下了铁证：
               [intercom] 清掉僵尸锁 seq=579（原持锁 pid=23832 ★存活=true★ 锁龄=60s）
             而她在跑多步任务时，一次投递（要等模型 + 执行动作）**本来就可能超过 60 秒**，
             于是"抢活人的锁"变成了常态 ✗ —— 两边同时投，消息可能被投两遍或投丢 ✓。
             新判据分三种情况：
               · !alive             → 立刻抢 ✓（真僵尸：持锁进程已经不在了）
               · alive 且 > 10 分钟  → 抢 ✓（活着但明显卡死了，不能再等）
               · 其余               → 老实等着 ✓（这是"别人正在干活"，不是僵尸）
             日志也分开写，免得以后再看到"存活=true"却标着"僵尸锁"这种自相矛盾的记录 ✓。 */
          const STALE_MS = 600000;   // 10 分钟
          if (!alive) {
            fs.writeFileSync(lock, String(process.pid));
            took = true;
            dbg('[intercom] 清掉僵尸锁 seq=' + seq + '（原持锁 pid=' + holderPid
              + ' 已不存在，锁龄=' + Math.round(ageMs / 1000) + 's）—— 这条本来永远投不出去');
          } else if (ageMs > STALE_MS) {
            fs.writeFileSync(lock, String(process.pid));
            took = true;
            dbg('[intercom] 抢占超时锁 seq=' + seq + '（原持锁 pid=' + holderPid
              + ' 仍存活，但锁龄已 ' + Math.round(ageMs / 1000) + 's > ' + (STALE_MS / 1000) + 's，判定卡死）');
          }
        } catch (e2) { /* 拿不到锁信息就照旧跳过 */ }
      }
      if (!took) {
        /* ★★★ 这里原来是 `lastSeq = seq; return;` —— 那是个坑（2026-10-03 实测）★★★
           它的意思是"别人正在投这条，我就当它投过了"。可是如果那个"别人"**中途死了**
           （崩溃 / 被 kill / 启动到一半退出），锁会被清掉或变成僵尸锁，
           而**我们已经在内存里把这条划掉了** → 于是再也不会重试 ✗。
           实测现场：lock-573 留着、持锁 pid 21984 已死、其它实例的 lastSeq 已经是 573，
           结果那条消息几分钟都没投出去，日志里一个字都没有 ✗。
           正确做法：**锁只负责互斥，不负责"标记完成"**。抢不到就静静等下一轮，
           完成与否一律以 done 文件为准（那是唯一的事实来源）。
           interval 只有 1.5s，重试的代价可以忽略。 */
        return;
      }
      let delivered = false;
      try {
        let w = chatWinOf();
        if (!w || w.isDestroyed()) {
          /* 对话窗没开就没地方投递。钩子跑在她自己进程里（管理员），有权限自己开窗。 */
          try { if (ctx.createChat) ctx.createChat(); } catch (e) { dbg('[intercom] 开对话窗失败: ' + e); }
          await new Promise((r) => setTimeout(r, 5000));
          w = chatWinOf();
          if (!w || w.isDestroyed()) { dbg('[intercom] 还是没有对话窗，放弃这条 seq=' + seq); return; }
        }
        /* 用渲染层自己的 send()：完全等于用户手打 */
        const js = 'typeof send === "function" ? (send(' + JSON.stringify(text) + '), "ok") : "no-send"';
        const r = await w.webContents.executeJavaScript(js);
        delivered = true;
        lastSeq = seq;
        try { fs.writeFileSync(donePath(), String(seq)); } catch {}
        dbg('[intercom] 已把第 ' + seq + ' 条喂给她（' + r + '）：' + text.slice(0, 80));
      } finally {
        /* 没投成就把锁放开，让下一个 tick（或下一个进程）重试；投成了就删锁。 */
        if (!delivered) { try { fs.unlinkSync(lock); } catch {} }
        else { try { fs.unlinkSync(lock); } catch {} }
      }
    } catch (e) {
      try { ctx.dbg('[intercom] 出错: ' + ((e && e.message) || e)); } catch {}
    }
  }, 1500);
  return true;
}

module.exports = { install, filePath };
