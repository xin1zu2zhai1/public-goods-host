// 版数を更新する（開発用）。使い方: node scripts/set-version.mjs 1.2.1
// index.html と js/*.js の「?v=版数」、index.html の APP_VERSION、version.json を書き換える。
// ブラウザやGitHub Pagesに古いファイルが残っていても、新しい版を読み込ませるための仕組み。
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const version = process.argv[2];
if (!version || !/^[0-9A-Za-z.-]+$/.test(version)) {
  console.error('使い方: node scripts/set-version.mjs 1.2.1');
  process.exit(1);
}
const files = ['index.html', ...readdirSync(join(root, 'js')).filter((f) => f.endsWith('.js')).map((f) => `js/${f}`)];
for (const f of files) {
  const p = join(root, f);
  const before = readFileSync(p, 'utf8');
  const after = before
    .replace(/(\.(?:js|css))\?v=[0-9A-Za-z.-]+/g, `$1?v=${version}`)
    .replace(/APP_VERSION = '[^']*'/g, `APP_VERSION = '${version}'`);
  if (after !== before) writeFileSync(p, after);
}
writeFileSync(join(root, 'version.json'), `${JSON.stringify({ version }, null, 2)}\n`);
console.log(`version ${version}`);
