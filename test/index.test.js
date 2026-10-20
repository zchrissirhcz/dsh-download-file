import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { apply } from '../index.js';

// 构造捕获注册定义的 mock ctx
function makeCtx(wd) {
  const registered = [];
  const ctx = {
    get: () => wd,
    tools: {
      register: (def) => {
        registered.push(def);
        return 'DISPOSER';
      }
    }
  };
  return { ctx, getDef: () => registered[0] };
}

let server, base, tmp;
const cleanups = [];

test.before(async () => {
  server = http.createServer((_req, res) => res.writeHead(200).end('hello-index\n'));
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
  tmp = await mkdtemp(path.join(process.cwd(), '.dl-idx-'));
});

test.after(async () => {
  await server.close();
  await rm(tmp, { recursive: true, force: true });
  for (const f of cleanups) await rm(f, { force: true });
});

test('apply 注册 download_file 工具并返回 disposer', () => {
  const { ctx, getDef } = makeCtx(null);
  assert.equal(apply(ctx), 'DISPOSER');
  const def = getDef();
  assert.equal(def.name, 'download_file');
  assert.deepEqual(def.parameters.required, ['url']);
  assert.equal(def.parameters.properties.overwrite.type, 'boolean');
  assert.equal(def.output.schema.properties.skipped.type, 'boolean');
});

test('render 三分支', () => {
  const { ctx, getDef } = makeCtx(null);
  apply(ctx);
  const { render } = getDef().output;
  assert.match(render(null, { skipped: true, saved_to: '/x' })[0].text, /未覆盖/);
  assert.match(render(null, { ok: true, bytes: 5, saved_to: '/x', preview: 'hi' })[0].text, /已保存 5 字节/);
  assert.equal(render(null, {})[0].text, '下载失败');
});

test('execute 用 workingDirectory.ensure 的 cwd', async () => {
  const wd = { ensure: async () => tmp };
  const { ctx, getDef } = makeCtx(wd);
  apply(ctx);
  const r = await getDef().execute({ url: `${base}/a.txt` }, { agent: 'a' });
  assert.equal(r.ok, true);
  assert.equal(r.saved_to, path.join(tmp, 'a.txt'));
  assert.equal(r.preview, 'hello-index\n');
});

test('execute 在 ensure 抛错时回退进程 cwd', async () => {
  const wd = { ensure: async () => { throw new Error('boom'); } };
  const { ctx, getDef } = makeCtx(wd);
  apply(ctx);
  const r = await getDef().execute({ url: `${base}/cwd-fallback-a.txt` }, { agent: 'a' });
  assert.equal(r.ok, true);
  assert.equal(r.saved_to, path.join(process.cwd(), 'cwd-fallback-a.txt'));
  cleanups.push(r.saved_to);
});

test('execute 在无 workingDirectory 时用进程 cwd', async () => {
  const { ctx, getDef } = makeCtx(null);
  apply(ctx);
  const r = await getDef().execute({ url: `${base}/cwd-fallback-b.txt` }, { agent: 'a' });
  assert.equal(r.ok, true);
  assert.equal(r.saved_to, path.join(process.cwd(), 'cwd-fallback-b.txt'));
  cleanups.push(r.saved_to);
});