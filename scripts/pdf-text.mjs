// Розбір PDF з текстових потоків: повертає рядки тексту.
// Спільно для «Рейтингу успішності студентів» і наказів про зарахування.
//
// Шрифти в цих PDF зашифровані (Identity-H + ToUnicode-CMap), тож просто
// «витягнути текст» не можна — треба відновити кодування через карти шрифту.

import zlib from 'node:zlib';
import { readFile } from 'node:fs/promises';

export async function extractLines(source) {
  const buf = /^https?:/i.test(source)
    ? Buffer.from(await (await fetch(source, { headers: { 'user-agent': 'okhttp/4.12.0' } })).arrayBuffer())
    : await readFile(source);
  const src = buf.toString('latin1');

  const objects = new Map();
  const objRe = /(\d+)\s+0\s+obj\b/g;
  let m;
  while ((m = objRe.exec(src))) {
    const num = Number(m[1]);
    const end = src.indexOf('endobj', m.index);
    objects.set(num, { body: src.slice(m.index, end < 0 ? src.length : end), start: m.index });
  }

  function rawStream(obj) {
    const sIdx = obj.body.indexOf('stream');
    if (sIdx < 0) return null;
    let start = sIdx + 6;
    if (src[obj.start + start] === '\r') start++;
    if (src[obj.start + start] === '\n') start++;
    const abs = obj.start + start;
    const end = src.indexOf('endstream', abs);
    const raw = Buffer.from(src.slice(abs, end < 0 ? abs : end), 'latin1');
    if (/\/FlateDecode/.test(obj.body.slice(0, sIdx))) {
      try { return zlib.inflateSync(raw); } catch (e) { return null; }
    }
    return raw;
  }

  // Об'єктні потоки: усередині них живуть самі PDF-об'єкти (сторінки, шрифти).
  for (const [num, obj] of [...objects]) {
    if (!/\/Type\s*\/ObjStm/.test(obj.body)) continue;
    const data = rawStream(obj);
    if (!data) continue;
    const first = Number((obj.body.match(/\/First\s+(\d+)/) || [])[1] || 0);
    const count = Number((obj.body.match(/\/N\s+(\d+)/) || [])[1] || 0);
    const header = data.slice(0, first).toString('latin1').trim().split(/\s+/).map(Number);
    const content = data.slice(first).toString('latin1');
    for (let i = 0; i < count; i++) {
      const num2 = header[i * 2];
      const off = header[i * 2 + 1];
      if (num2 === undefined || off === undefined || objects.has(num2)) continue;
      const next = (i + 1 < count) ? header[i * 2 + 3] : content.length;
      objects.set(num2, { body: content.slice(off, next), start: 0 });
    }
  }

  function parseCMap(text) {
    const map = new Map();
    for (const block of text.match(/beginbfchar([\s\S]*?)endbfchar/g) || []) {
      for (const cm of block.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
        map.set(parseInt(cm[1], 16), String.fromCharCode(parseInt(cm[2], 16)));
      }
    }
    for (const block of text.match(/beginbfrange([\s\S]*?)endbfrange/g) || []) {
      // Запис діапазону: або <from> <to> [ ... ], або <from> <to> <base>.
      // Розбираємо записи по черзі, щоб масив не сплутати з діапазоном.
      const entryRe = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(?:\[([\s\S]*?)\]|<([0-9A-Fa-f]+)>)/g;
      for (const cm of block.matchAll(entryRe)) {
        const from = parseInt(cm[1], 16);
        const to = parseInt(cm[2], 16);
        if (cm[3] !== undefined) {
          const dests = [...cm[3].matchAll(/<([0-9A-Fa-f]+)>/g)].map((d) => String.fromCharCode(parseInt(d[1], 16)));
          dests.forEach((d, i) => map.set(from + i, d));
        } else {
          const base = parseInt(cm[4], 16);
          for (let i = from; i <= to && i - from < 4096; i++) map.set(i, String.fromCharCode(base + (i - from)));
        }
      }
    }
    return map;
  }

  const fontMaps = new Map();
  for (const [num, obj] of objects) {
    const tu = obj.body.match(/\/ToUnicode\s+(\d+)\s+0\s+R/);
    if (!tu) continue;
    const target = objects.get(Number(tu[1]));
    if (!target) continue;
    const data = rawStream(target);
    if (!data) continue;
    const map = parseCMap(data.toString('latin1'));
    if (map.size) fontMaps.set(num, map);
  }

  const resourceFonts = new Map();
  for (const obj of objects.values()) {
    let body = obj.body;
    const ref = body.match(/\/Resources\s+(\d+)\s+0\s+R/);
    if (ref && objects.has(Number(ref[1]))) body = objects.get(Number(ref[1])).body;
    const fontBlock = body.match(/\/Font\s*<<([^>]*)>>/s);
    if (!fontBlock) continue;
    for (const e of fontBlock[1].matchAll(/\/([A-Za-z0-9#+._-]+)\s+(\d+)\s+0\s+R/g)) {
      const map = fontMaps.get(Number(e[2]));
      if (!map) continue;
      // Type0/Identity-H кодує символи двома байтами, прості шрифти — одним.
      const fontObj = objects.get(Number(e[2]));
      const twoByte = !fontObj || /\/Subtype\s*\/Type0/.test(fontObj.body) || /Identity-[HV]/.test(fontObj.body);
      resourceFonts.set(e[1], { map, twoByte });
    }
  }

  function decodeString(bytes, font) {
    const map = font && font.map;
    let out = '';
    if (font && font.twoByte) {
      for (let i = 0; i + 1 < bytes.length; i += 2) {
        const code = (bytes[i] << 8) | bytes[i + 1];
        out += (map && map.has(code)) ? map.get(code) : '';
      }
      return out;
    }
    for (const b of bytes) out += map && map.has(b) ? map.get(b) : String.fromCharCode(b);
    return out;
  }

  function literalBytes(str) {
    const bytes = [];
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      if (ch === '\\') {
        const n = str[++i];
        if (n === 'n') bytes.push(10);
        else if (n === 'r') bytes.push(13);
        else if (n === 't') bytes.push(9);
        else if (/[0-7]/.test(n)) {
          const oct = str.slice(i, i + 3).match(/^[0-7]{1,3}/)[0];
          bytes.push(parseInt(oct, 8));
          i += oct.length - 1;
        } else bytes.push(n.charCodeAt(0) & 0xff);
      } else bytes.push(ch.charCodeAt(0) & 0xff);
    }
    return Buffer.from(bytes);
  }

  function hexBytes(str) {
    const h = str.replace(/\s+/g, '');
    const bytes = [];
    for (let i = 0; i + 1 < h.length; i += 2) bytes.push(parseInt(h.substr(i, 2), 16));
    return Buffer.from(bytes);
  }

  const lines = [];
  for (const obj of objects.values()) {
    const data = rawStream(obj);
    if (!data) continue;
    const content = data.toString('latin1');
    if (!content.includes('BT')) continue;
    let font = null;
    let line = '';
    const tokenRe = /\/([A-Za-z0-9#+._-]+)\s+[\d.]+\s+Tf|\((?:\\.|[^()\\])*\)\s*Tj|<[0-9A-Fa-f\s]+>\s*Tj|\[(?:[^\]])*\]\s*TJ|T\*|Td|TD|Tm|'|"/g;
    let cm;
    while ((cm = tokenRe.exec(content))) {
      const tok = cm[0];
      if (/Tf$/.test(tok)) font = resourceFonts.get(cm[1]) || null;
      else if (/^\(/.test(tok)) line += decodeString(literalBytes(tok.slice(1, tok.lastIndexOf(')'))), font);
      else if (/^</.test(tok)) line += decodeString(hexBytes(tok.slice(1, tok.indexOf('>'))), font);
      else if (/^\[/.test(tok)) {
        const arr = tok.slice(0, tok.lastIndexOf(']'));
        for (const p of arr.match(/\((?:\\.|[^()\\])*\)/g) || []) line += decodeString(literalBytes(p.slice(1, -1)), font);
        for (const p of arr.match(/<[0-9A-Fa-f\s]+>/g) || []) line += decodeString(hexBytes(p.slice(1, -1)), font);
      } else {
        if (line.trim()) lines.push(line.trim());
        line = '';
      }
    }
    if (line.trim()) lines.push(line.trim());
  }
  return lines;
}
