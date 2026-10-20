// 배포용 파일 만들기 (호스팅에는 빌드 명령이 없으므로 결과물을 저장소에 같이 커밋한다)
//   node build.mjs          → src/js/*.js → ../../js/*.js,  src/css/*.css → ../../css/*.css,  css/tailwind.css 생성
//                             + 앱 파일 내용으로 앱 버전을 계산해 sw.js / index.html 에 넣는다(새 버전 알림용)
//   node build.mjs --check  → 아무것도 쓰지 않고, 커밋된 결과물이 src 와 일치하는지만 검사(다르면 종료 코드 1)
// 변환은 "공백/주석 제거 + 문법 줄이기"만 한다. 변수·함수 이름은 바꾸지 않는다(HTML 의 onclick="…" 같은 이름 참조가 안전하도록).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
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
// 앱 버전: 배포되는 앱 파일(index.html, manifest, js/, css/, sw.js) 내용으로 계산해 sw.js 의 APP_VERSION 과
// index.html 의 <meta name="app-version"> 에 넣는다. 값이 바뀌면 브라우저가 새 서비스워커를 받아 "업데이트" 알림을 띄운다.
// (두 파일 안의 버전 값 자리는 비운 상태로 계산하므로, 값을 넣어도 계산 결과가 달라지지 않는다)
{
  const SW_RE = /const APP_VERSION = '[0-9a-f]*';/, META_RE = /<meta name="app-version" content="[0-9a-f]*">/;
  const blank = (rel, txt) => rel === 'sw.js' ? txt.replace(SW_RE, "const APP_VERSION = '';") : rel === 'index.html' ? txt.replace(META_RE, '<meta name="app-version" content="">') : txt;
  const files = ['index.html', 'manifest.webmanifest', 'sw.js',
    ...['js', 'css'].flatMap((d) => fs.readdirSync(path.join(ROOT, d)).filter((n) => /\.(js|css)$/.test(n)).sort().map((n) => `${d}/${n}`))];
  const h = createHash('sha256');
  for (const rel of files) {
    // check 모드에서 tailwind.css 는 방금 만든 결과로 계산(커밋된 파일이 다르면 어차피 위에서 stale)
    const txt = check && rel === 'css/tailwind.css' ? fs.readFileSync(twOut, 'utf8') : fs.readFileSync(path.join(ROOT, rel), 'utf8');
    h.update(rel + '\0' + blank(rel, txt) + '\0');
  }
  const version = h.digest('hex').slice(0, 12);
  for (const [rel, re, val] of [['sw.js', SW_RE, `const APP_VERSION = '${version}';`], ['index.html', META_RE, `<meta name="app-version" content="${version}">`]]) {
    const cur = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    if (!re.test(cur)) { console.error(`${rel} 에서 버전 자리를 찾지 못했어요.`); process.exit(1); }
    const next = cur.replace(re, val);
    if (next !== cur) { if (check) stale.push(rel + ' (앱 버전)'); else fs.writeFileSync(path.join(ROOT, rel), next); }
  }
  if (!check) console.log(`앱 버전 ${version}`);
}

if (check) {
  const cur = fs.existsSync(path.join(ROOT, 'css/tailwind.css')) ? fs.readFileSync(path.join(ROOT, 'css/tailwind.css'), 'utf8') : null;
  if (cur !== fs.readFileSync(twOut, 'utf8')) stale.push('css/tailwind.css');
  fs.rmSync(twOut, { force: true });
  if (stale.length) { console.error('빌드 결과물이 src 와 달라요(npm run build 를 실행해서 같이 커밋하세요):\n  ' + stale.join('\n  ')); process.exit(1); }
  console.log('빌드 결과물이 최신이에요.');
} else {
  console.log(`합계 ${before} → ${after} bytes`);
}
