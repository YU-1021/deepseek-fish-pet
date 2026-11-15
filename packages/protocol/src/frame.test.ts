import test from 'node:test';
import assert from 'node:assert/strict';
import { Type } from '@sinclair/typebox';
import { ErrorCodes, assertParams, parseInbound, PROTOCOL_VERSION } from './index.js';

test('parseInbound: 合法 connect 帧', () => {
  const r = parseInbound(JSON.stringify({ type: 'connect', protocol: PROTOCOL_VERSION, token: 'a'.repeat(32), client: { name: 'pet-ui', version: '0.1.0', pid: 123 } }));
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.frame.type, 'connect');
    if (r.frame.type === 'connect') assert.equal(r.frame.client.name, 'pet-ui');
  }
});

test('parseInbound: 非法 JSON → E_BAD_FRAME', () => {
  const r = parseInbound('{not json');
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.code, ErrorCodes.BAD_FRAME);
});

test('parseInbound: 非对象 → E_BAD_FRAME', () => {
  const r = parseInbound('[1,2,3]');
  assert.equal(r.ok, false);
});

test('parseInbound: 服务端帧（res）不允许从客户端来', () => {
  const r = parseInbound(JSON.stringify({ type: 'res', id: '1', ok: true }));
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.code, ErrorCodes.BAD_FRAME);
});

test('parseInbound: connect 缺 token → E_HANDSHAKE', () => {
  const r = parseInbound(JSON.stringify({ type: 'connect', client: { name: 'x', version: '1' } }));
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.code, ErrorCodes.HANDSHAKE);
});

test('parseInbound: 合法 req 帧（params 可省略）', () => {
  const r = parseInbound(JSON.stringify({ type: 'req', id: 'r1', method: 'health.ping' }));
  assert.equal(r.ok, true);
});

test('parseInbound: req id 为空串不合法', () => {
  const r = parseInbound(JSON.stringify({ type: 'req', id: '', method: 'health.ping' }));
  assert.equal(r.ok, false);
});

test('assertParams: 无 schema 时放行', () => {
  assert.equal(assertParams(undefined, 123), null);
});

test('assertParams: schema 通过/拒绝', () => {
  const schema = Type.Object({ value: Type.Integer({ minimum: 0 }) });
  assert.equal(assertParams(schema, { value: 3 }), null);
  // 缺省按 {} → 必填字段缺失，应拒绝
  const missing = assertParams(schema, undefined);
  assert.ok(missing && missing.code === ErrorCodes.BAD_PARAMS);
  const bad = assertParams(schema, { value: -1 });
  assert.ok(bad && bad.code === ErrorCodes.BAD_PARAMS);
});

test('错误码全部非空且唯一', () => {
  const codes = Object.values(ErrorCodes);
  assert.equal(codes.length, new Set(codes).size);
  for (const c of codes) assert.ok(c.startsWith('E_'));
});
