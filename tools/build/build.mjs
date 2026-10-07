// 배포용 파일 만들기 (호스팅에는 빌드 명령이 없으므로 결과물을 저장소에 같이 커밋한다)
//   node build.mjs          → src/js/*.js → ../../js/*.js,  src/css/*.css → ../../css/*.css,  css/tailwind.css 생성
//   node build.mjs --check  → 아무것도 쓰지 않고, 커밋된 결과물이 src 와 일치하는지만 검사(다르면 종료 코드 1)
// 변환은 "공백/주석 제거 + 문법 줄이기"만 한다. 변수·함수 이름은 바꾸지 않는다(HTML 의 onclick="…" 같은 이름 참조가 안전하도록).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { transform } from 'esbuild';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const check = process.argv.includes('--check');
let stale = [];

async function emit(srcFile, outFile, loader) {
  const code = fs.readFileSync(srcFile, 'utf8');
  const { code: out } = await transform(code, {
    loader, minifyWhitespace: true, minifySyntax: true, minifyIdentifiers: false, charset: 'utf8', legalComments: 'none', target: 'es2022',
  });
  const body = (loader === 'css' && !out.startsWith('@charset') ? '@charset "UTF-8";' : '') + out;
  if (check) {
    const cur = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : null;
    if (cur !== body) stale.push(path.relative(ROOT, outFile));
  } else {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, body);
  }
  return [code.length, body.length];
}

let before = 0, after = 0;
for (const [dir, ext, loader] of [['js', '.js', 'js'], ['css', '.css', 'css']]) {
  for (const f of fs.readdirSync(path.join(ROOT, 'src', dir)).filter((n) => n.endsWith(ext)).sort()) {
    const [a, b] = await emit(path.join(ROOT, 'src', dir, f), path.join(ROOT, dir, f), loader);
    before += a; after += b;
    if (!check) console.log(`${dir}/${f}: ${a} → ${b} bytes`);
  }
}

// 플래너용 Tailwind CSS (css/tailwind.css)
const twOut = check ? path.join(os.tmpdir(), `tw-${process.pid}.css`) : path.join(ROOT, 'css/tailwind.css');
execFileSync(path.join(HERE, 'node_modules/.bin/tailwindcss'), ['-c', path.join(HERE, 'tailwind.config.js'), '-i', path.join(HERE, 'input.css'), '-o', twOut, '--minify'], { cwd: HERE, stdio: 'pipe' });
if (check) {
  const cur = fs.existsSync(path.join(ROOT, 'css/tailwind.css')) ? fs.readFileSync(path.join(ROOT, 'css/tailwind.css'), 'utf8') : null;
  if (cur !== fs.readFileSync(twOut, 'utf8')) stale.push('css/tailwind.css');
  fs.rmSync(twOut, { force: true });
  if (stale.length) { console.error('빌드 결과물이 src 와 달라요(npm run build 를 실행해서 같이 커밋하세요):\n  ' + stale.join('\n  ')); process.exit(1); }
  console.log('빌드 결과물이 최신이에요.');
} else {
  console.log(`합계 ${before} → ${after} bytes`);
}
