import { WebSocketServer } from 'ws';
const port = Number(process.argv[2] ?? 8765);
const server = new WebSocketServer({ host: '127.0.0.1', port });
server.on('connection', (socket) => socket.on('message', (raw) => {
  const frame = JSON.parse(String(raw));
  if (frame.type === 'connect') socket.send(JSON.stringify({ type: 'hello', server: { name: 'petd', version: '0.1.0-mock', protocol: 1, pid: process.pid }, sessionId: 'mock-session' }));
  if (frame.type === 'req') {
    const data = frame.method === 'health.status' ? { server: { version: '0.1.0-mock' }, methods: ['health.ping', 'health.status', 'persona.get'] } : { pong: true };
    socket.send(JSON.stringify({ type: 'res', id: frame.id, ok: true, data }));
  }
}));
console.log(`Mock gateway listening on ws://127.0.0.1:${port}`);
