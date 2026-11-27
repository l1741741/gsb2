import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import module from 'node:module';

const stripTypeScriptTypes = module.stripTypeScriptTypes;
if (typeof stripTypeScriptTypes !== 'function') {
  console.error('需要 Node.js 22.18+（内置 stripTypeScriptTypes）。');
  process.exit(1);
}

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const port = Number(process.env.PORT ?? 4174);
const host = process.env.HOST ?? '127.0.0.1';

const MIME = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.ts', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
]);

/**
 * 开发服务器：因为浏览器不能直接执行 TypeScript，
 * 这里用 Node 内置的 stripTypeScriptTypes 把 .ts 实时转成 JS 再返回。
 * 只做类型擦除（不做类型检查），类型检查交给 `npm run typecheck`。
 */
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', `http://${host}`);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/') pathname = '/web/index.html';

    const relative = pathname.replace(/^\/+/, '');
    const target = join(root, relative);
    // 防目录穿越：解析后必须仍在仓库目录内。
    if (!target.startsWith(root + sep) && target !== root) {
      response.writeHead(403).end('forbidden');
      return;
    }

    const info = await stat(target).catch(() => null);
    if (!info || !info.isFile()) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(`not found: ${pathname}`);
      return;
    }

    let body = await readFile(target, 'utf8');
    const extension = extname(target);
    if (extension === '.ts') {
      body = stripTypeScriptTypes(body, { mode: 'strip' });
    }

    // 相对导入保持原样（浏览器会按 URL 解析）；这里只补 content-type。
    response.writeHead(200, {
      'content-type': MIME.get(extension) ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    response.end(body);
  } catch (error) {
    response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    response.end(`server error: ${error instanceof Error ? error.message : String(error)}`);
  }
});

server.listen(port, host, () => {
  console.log(`帆船靠站练习：http://${host}:${port}/`);
  console.log(`目录：${normalize(root)}`);
});
