/* 极简事件总线（生命周期钩子）
 * 记忆系统、以及后续要接入的新系统（学习/经验积累、DSH 联动…）
 * 都通过这里收发事件，彼此不直接 require，避免"一接入就互相踩"。
 *
 * 当前已约定的事件：
 *   app:start         应用就绪（可做迁移、清理、恢复）
 *   session:start     一个会话开始（含恢复出来的草稿）
 *   session:turn      一轮对话结束（user/assistant 已入库）
 *   session:end       会话收尾（写摘要、抽要点）
 *   memory:changed    某个记忆命名空间发生变化（UI 可据此刷新）
 */
const { EventEmitter } = require('events');
const bus = new EventEmitter();
bus.setMaxListeners(100);
module.exports = bus;
