// 앱스토어용 ZIP 도구(외부 라이브러리 없이, 브라우저 안에서만 동작) - 화면/네트워크와 무관한 순수 함수들이라 따로 둔다.
//  - zipOpen : 올린 ZIP 의 목록만 읽고 안전성을 먼저 검사(경로 조작 ../ , 절대 경로, 암호/ZIP64 거부, 파일 수·크기·압축률 제한)한 뒤 필요한 파일만 푼다.
//  - makeZip : 압축 없이 담는(store) 간단한 ZIP 만들기 - 배포 도우미가 index.html 이 든 ZIP 을 만들어 줄 때 쓴다.
//  한도(limits: zipEntries/zipFileBytes/zipTotalBytes)와 크기 표시 함수(fmtSize)는 호출하는 쪽(appstore.js)이 넘겨 준다.

// ---------------------------------------------------------------- ZIP 읽기(외부 라이브러리 없이) - 경로 조작/압축 폭탄을 막으면서 메모리에서만 푼다
export class ZipError extends Error {}
export function zipSafePath(raw) {
    const name = String(raw).replace(/\\/g, '/');
    if (name.includes('\0')) throw new ZipError('ZIP 안에 올바르지 않은 파일 이름이 있어요.');
    if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) throw new ZipError(`ZIP 안에 절대 경로가 있어요: ${name}`);
    const parts = name.split('/');
    if (parts.some(p => p === '..')) throw new ZipError(`ZIP 안에 허용되지 않는 경로(../)가 있어요: ${name}`);
    return parts.filter(p => p && p !== '.').join('/') + (name.endsWith('/') ? '/' : '');
}
export async function zipInflate(bytes, expectedSize) {
    if (typeof DecompressionStream === 'undefined') throw new ZipError('이 브라우저는 ZIP 앱 실행을 지원하지 않아요. 최신 Chrome / Safari / Firefox 로 열어주세요.');
    const ds = new DecompressionStream('deflate-raw');
    const reader = new Blob([bytes]).stream().pipeThrough(ds).getReader();
    const out = new Uint8Array(expectedSize);
    let off = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (off + value.length > expectedSize) { try { reader.cancel(); } catch (e) {} throw new ZipError('압축 해제 크기가 ZIP에 적힌 값과 달라요.'); }
        out.set(value, off); off += value.length;
    }
    if (off !== expectedSize) throw new ZipError('압축 해제 크기가 ZIP에 적힌 값과 달라요.');
    return out;
}
// 목록만 읽고(파일 내용은 아직 안 푼다) 안전성을 먼저 검사한 뒤, 필요한 파일만 extract()로 푼다.
export function zipOpen(buf, limits, fmtSize) {
    const u8 = new Uint8Array(buf), view = new DataView(buf);
    let eocd = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 22 - 65535); i--) { if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; } }
    if (eocd < 0) throw new ZipError('올바른 ZIP 파일이 아니에요.');
    const total = view.getUint16(eocd + 10, true), cdOff = view.getUint32(eocd + 16, true);
    if (total === 0xffff || cdOff === 0xffffffff) throw new ZipError('ZIP64 형식은 지원하지 않아요. 파일을 다시 압축해주세요.');
    if (total > limits.zipEntries) throw new ZipError(`ZIP 안의 파일이 너무 많아요 (최대 ${limits.zipEntries}개).`);
    const entries = new Map(); let p = cdOff, totalSize = 0;
    const dec = new TextDecoder('utf-8');
    for (let i = 0; i < total; i++) {
        if (p + 46 > u8.length || view.getUint32(p, true) !== 0x02014b50) throw new ZipError('ZIP 파일이 손상됐어요.');
        const flags = view.getUint16(p + 8, true), method = view.getUint16(p + 10, true);
        const csize = view.getUint32(p + 20, true), usize = view.getUint32(p + 24, true);
        const nlen = view.getUint16(p + 28, true), elen = view.getUint16(p + 30, true), clen = view.getUint16(p + 32, true);
        const lho = view.getUint32(p + 42, true);
        const rawName = dec.decode(u8.subarray(p + 46, p + 46 + nlen));
        p += 46 + nlen + elen + clen;
        const name = zipSafePath(rawName); // 위험한 경로가 하나라도 있으면 ZIP 전체를 거부한다
        if (!name || name.endsWith('/')) continue; // 폴더
        if (name.startsWith('__MACOSX/') || name.split('/').pop() === '.DS_Store') continue;
        if (flags & 1) throw new ZipError('암호가 걸린 ZIP은 올릴 수 없어요.');
        if (method !== 0 && method !== 8) throw new ZipError(`지원하지 않는 압축 방식이에요: ${name}`);
        if (usize > limits.zipFileBytes) throw new ZipError(`파일이 너무 커요(최대 ${fmtSize(limits.zipFileBytes)}): ${name}`);
        if (usize > 1048576 && csize > 0 && usize / csize > 200) throw new ZipError(`비정상적으로 높은 압축률의 파일이 있어요: ${name}`);
        totalSize += usize;
        if (totalSize > limits.zipTotalBytes) throw new ZipError(`압축을 풀면 너무 커요 (최대 ${fmtSize(limits.zipTotalBytes)}).`);
        if (entries.has(name)) throw new ZipError(`같은 이름의 파일이 두 번 들어 있어요: ${name}`);
        entries.set(name, { name, method, csize, usize, lho });
    }
    // 진입점: 최상위 index.html, 아니면 모든 파일이 한 폴더 안에 있고 그 안에 index.html 이 있을 때
    let root = '';
    if (!entries.has('index.html')) {
        const tops = new Set([...entries.keys()].map(n => n.split('/')[0]));
        const only = tops.size === 1 ? [...tops][0] : null;
        if (only && entries.has(`${only}/index.html`) && [...entries.keys()].every(n => n.startsWith(only + '/'))) root = only + '/';
        else throw new ZipError('ZIP 맨 위(또는 하나뿐인 폴더 안)에 index.html 이 있어야 해요.');
    }
    async function extract(name) {
        const e = entries.get(name); if (!e) return null;
        if (view.getUint32(e.lho, true) !== 0x04034b50) throw new ZipError('ZIP 파일이 손상됐어요.');
        const start = e.lho + 30 + view.getUint16(e.lho + 26, true) + view.getUint16(e.lho + 28, true);
        if (start + e.csize > u8.length) throw new ZipError('ZIP 파일이 손상됐어요.');
        const data = u8.subarray(start, start + e.csize);
        if (e.method === 0) { if (e.csize !== e.usize) throw new ZipError('ZIP 파일이 손상됐어요.'); return data.slice(); }
        return zipInflate(data, e.usize);
    }
    return { entries, root, extract, count: entries.size };
}

const crcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; } return t; })();
function crc32(bytes) { let c = 0xFFFFFFFF; for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
export function makeZip(entries) { // 압축 없이 담기(store) - 구조가 단순해서 어디서나 열린다
    const enc = new TextEncoder(); const chunks = []; const central = []; let offset = 0;
    const now = new Date(); const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1); const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    for (const e of entries) {
        const name = enc.encode(e.name), data = e.data, crc = crc32(data);
        const lh = new DataView(new ArrayBuffer(30)); lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
        lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true); lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
        chunks.push(new Uint8Array(lh.buffer), name, data);
        const ch = new DataView(new ArrayBuffer(46)); ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
        ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true); ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, name.length, true); ch.setUint32(42, offset, true);
        central.push(new Uint8Array(ch.buffer), name);
        offset += 30 + name.length + data.length;
    }
    const centralSize = central.reduce((n, c) => n + c.length, 0);
    const end = new DataView(new ArrayBuffer(22)); end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true); end.setUint32(12, centralSize, true); end.setUint32(16, offset, true);
    return new Blob([...chunks, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
}
