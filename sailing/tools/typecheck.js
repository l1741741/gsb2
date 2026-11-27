/** 类型检查入口：调用本地 TypeScript；未安装时给出可执行的提示。 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const localTsc = resolve(root, 'node_modules/typescript/bin/tsc');

if (!existsSync(localTsc)) {
  console.error('未找到本地 TypeScript。请先在 sailing/ 目录执行：npm install');
  process.exit(1);
}

const result = spawnSync(process.execPath, [localTsc, '-p', resolve(root, 'tsconfig.json'), '--noEmit'], {
  stdio: 'inherit',
  cwd: root,
});

process.exit(result.status ?? 1);
