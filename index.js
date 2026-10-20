import { createWriteStream } from 'node:fs';
import { mkdir, open, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';

export const inject = ['tools'];

const PREVIEW_BYTES = 4096;
const PREVIEW_LINES = 20;
const FETCH_TIMEOUT_MS = 120000;

export function deriveFilename(url) {
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop();
    if (last && !last.endsWith('/')) {
      try { return decodeURIComponent(last); } catch { return last; }
    }
  } catch { /* 非法 URL，回退时间戳名 */ }
  return `download-${Date.now()}`;
}

const isDir = async (p) => (await stat(p).catch(() => null))?.isDirectory() === true;

export async function resolveTarget(base, savePath, url) {
  let dir = base;
  let file = deriveFilename(url);
  if (typeof savePath === 'string' && savePath.trim()) {
    const p = path.resolve(base, savePath);
    if (savePath.endsWith('/') || savePath.endsWith(path.sep) || (await isDir(p))) dir = p;
    else { dir = path.dirname(p); file = path.basename(p) || file; }
  }
  return path.join(dir, file);
}

export async function readTextPreview(fullPath) {
  const handle = await open(fullPath, 'r');
  try {
    const buf = Buffer.alloc(PREVIEW_BYTES);
    const { bytesRead } = await handle.read(buf, 0, PREVIEW_BYTES, 0);
    const sample = buf.subarray(0, bytesRead);
    return sample.includes(0)
      ? { binary: true, preview: '(二进制文件，无文本预览)' }
      : { binary: false, preview: sample.toString('utf8').split(/\r?\n/).slice(0, PREVIEW_LINES).join('\n') };
  } finally {
    await handle.close();
  }
}

export async function downloadFile(url, { save_path, overwrite = false } = {}, { cwd = process.cwd(), signal, timeout = FETCH_TIMEOUT_MS } = {}) {
  if (!url || typeof url !== 'string') throw new Error('invalid url');
  const fullPath = await resolveTarget(cwd, save_path, url);
  const existing = await stat(fullPath).catch(() => null);
  if (existing && !overwrite) {
    return { ok: true, skipped: true, exists: true, url, saved_to: fullPath, bytes: existing.size };
  }
  const fetchSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
  const res = await fetch(url, { signal: fetchSignal });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} (${url})`);
  if (!res.body) throw new Error(`empty body (${url})`);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await pipeline(res.body, createWriteStream(fullPath), { signal: fetchSignal });
  const bytes = (await stat(fullPath)).size;
  const { binary, preview } = await readTextPreview(fullPath);
  return { ok: true, url, saved_to: fullPath, bytes, binary, preview };
}

export function apply(ctx) {
  return ctx.tools.register({
    name: 'download_file',
    description:
      '从 URL 下载一个文件并写入磁盘，返回保存路径、字节数与文本预览。逐字节原样保存（换行符/二进制不变），大小不限（流式），写盘不弹授权提示。目标文件是否已存在通过磁盘检查判断。',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: '文件完整 URL（内网 GitLab raw、公网 GitHub 等任意 http/https 地址）。必填。'
        },
        save_path: {
          type: 'string',
          description:
            '保存路径，可选。省略→当前工作目录（文件名取 URL 原始名）；以 / 结尾或指向已存在目录→作为目录；否则作为完整文件路径（相对 cwd，自动建父目录）。'
        },
        overwrite: {
          type: 'boolean',
          description:
            '目标文件已存在时的处理。true→覆盖；false（默认）→不下载、返回 skipped，不覆盖。'
        }
      },
      required: ['url']
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          url: { type: 'string' },
          saved_to: { type: 'string' },
          bytes: { type: 'integer' },
          binary: { type: 'boolean' },
          preview: { type: 'string' },
          skipped: { type: 'boolean' },
          exists: { type: 'boolean' }
        }
      },
      render(_args, value) {
        let text;
        if (value.skipped) text = `文件已存在，未覆盖（overwrite=false）：${value.saved_to}`;
        else if (value.ok) text = `已保存 ${value.bytes} 字节到 ${value.saved_to}\n${value.preview}`;
        else text = '下载失败';
        return [{ type: 'text', text }];
      }
    },
    async execute(args, exec) {
      const wd = ctx.get('workingDirectory');
      let cwd = process.cwd();
      try { cwd = wd ? await wd.ensure(exec.agent) : cwd; } catch { /* 回退进程 cwd */ }
      return downloadFile(
        args.url,
        { save_path: args.save_path, overwrite: args.overwrite },
        { cwd, signal: exec.signal }
      );
    }
  });
}