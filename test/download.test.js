import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { deriveFilename, downloadFile } from '../index.js';

const routes = new Map([
  ['/text-lf.txt', Buffer.from('line1\nline2\n')],
  ['/text-crlf.txt', Buffer.from('line1\r\nline2\r\n')],
  ['/bin.dat', Buffer.from([0, 1, 2, 254, 255, 128, 0, 3])],
  ['/large.bin', Buffer.alloc(5 * 1024 * 1024, 0x5a)]
]);

let server, base, tmp;

test.before(async () => {
  server = http.createServer((req, res) => {
    const body = routes.get(new URL(req.url, 'http://x').pathname);
    if (!body) return res.writeHead(404).end();
    res.writeHead(200).end(body);
  });
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
  tmp = await mkdtemp(path.join(process.cwd(), '.dl-test-'));
});

test.after(async () => {
  await server.close();
  await rm(tmp, { recursive: true, force: true });
});

const dl = (p, opts) => downloadFile(`${base}${p}`, opts, { cwd: tmp });

test('文本 LF/CRLF 换行逐字节保留，且返回文本预览', async () => {
  const lf = await dl('/text-lf.txt');
  assert.equal(lf.bytes, 12);
  assert.equal(await readFile(lf.saved_to, 'utf8'), 'line1\nline2\n');
  assert.equal(lf.binary, false);
  assert.equal(lf.preview, 'line1\nline2\n');

  const crlf = await dl('/text-crlf.txt');
  assert.equal(crlf.bytes, 14);
  assert.deepEqual(await readFile(crlf.saved_to), routes.get('/text-crlf.txt'));
});

test('二进制字节精确一致，预览为二进制提示', async () => {
  const r = await dl('/bin.dat');
  assert.deepEqual(await readFile(r.saved_to), routes.get('/bin.dat'));
  assert.equal(r.binary, true);
  assert.ok(r.preview.includes('二进制'));
});

test('大文件 5MB 完整下载且字节一致', async () => {
  const r = await dl('/large.bin');
  assert.equal(r.bytes, 5 * 1024 * 1024);
  const data = await readFile(r.saved_to);
  assert.equal(data.length, 5 * 1024 * 1024);
  assert.ok(data.every((b) => b === 0x5a));
});

test('save_path 三种语义', async () => {
  assert.equal((await dl('/text-lf.txt', { save_path: 'sub/' })).saved_to, path.join(tmp, 'sub', 'text-lf.txt'));

  const dir = path.join(tmp, 'out');
  await mkdir(dir);
  assert.equal((await dl('/text-lf.txt', { save_path: dir })).saved_to, path.join(dir, 'text-lf.txt'));

  const target = path.join(tmp, 'custom', 'deep', 'out.bin');
  assert.equal((await dl('/bin.dat', { save_path: target })).saved_to, target);
  assert.deepEqual(await readFile(target), routes.get('/bin.dat'));
});

test('HTTP 404 与空 url 抛错', async () => {
  await assert.rejects(dl('/missing'), /HTTP 404/);
  await assert.rejects(downloadFile('', {}, {}), /url/);
});

test('目标已存在：默认停止，overwrite 覆盖', async () => {
  const target = path.join(tmp, 'x.txt');
  await writeFile(target, 'OLD');
  const skip = await dl('/text-lf.txt', { save_path: target });
  assert.equal(skip.skipped, true);
  assert.equal(skip.bytes, 3);
  assert.equal(await readFile(target, 'utf8'), 'OLD'); // 未被覆盖
  const over = await dl('/text-lf.txt', { save_path: target, overwrite: true });
  assert.equal(over.skipped, undefined);
  assert.equal(await readFile(target, 'utf8'), 'line1\nline2\n'); // 已覆盖
});

test('deriveFilename 回退分支', () => {
  assert.match(deriveFilename('http://x/'), /^download-\d+$/); // 无路径段 → 时间戳名
  assert.match(deriveFilename('not a url'), /^download-\d+$/); // 非法 URL → 时间戳名
  assert.equal(deriveFilename('http://x/a%zz'), 'a%zz'); // 非法 % 编码 → 保留原始 last
});

test('downloadFile 超时中止', async () => {
  const hang = http.createServer(() => {}); // 永不响应
  await new Promise((r) => hang.listen(0, r));
  const hangBase = `http://127.0.0.1:${hang.address().port}`;
  try {
    await assert.rejects(
      downloadFile(`${hangBase}/slow.txt`, {}, { cwd: tmp, timeout: 50 }),
      /Timeout/i
    );
  } finally {
    hang.closeAllConnections?.();
    await hang.close();
  }
});

test('downloadFile 空响应体抛错', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, statusText: 'OK', body: null });
  try {
    await assert.rejects(downloadFile(`${base}/empty-body.txt`, {}, { cwd: tmp }), /empty body/);
  } finally {
    globalThis.fetch = orig;
  }
});