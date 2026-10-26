// Накази про зарахування на І курс -> список ПІБ.
//
// Накази коледжу лежать як WP-пости з PDF-вкладенням. У PDF немає групи —
// лише спеціальність, ПІБ і конкурсний бал. Групу дає журнальний API:
// запит «group + прізвище + ім'я» повертає 200 лише для справжнього студента.
//
// Запуск: node scripts/orders-pdf.mjs [--out file.json]

import fs from 'node:fs';
import { extractLines } from './pdf-text.mjs';

const args = process.argv.slice(2);
const OUT = args.includes('--out') ? args[args.indexOf('--out') + 1] : '';
const WP = 'https://sclnau.com.ua/wp-json/wp/v2';
const HEADERS = { 'user-agent': 'okhttp/4.12.0' };
const SINCE = '2026-07-01T00:00:00';

async function wp(path) {
  const res = await fetch(WP + path, { headers: HEADERS });
  if (!res.ok) throw new Error(path + ' -> HTTP ' + res.status);
  return res.json();
}

// Токен ПІБ: велика перша літера, далі малі. «Свідоцтво» таким є, але стоїть
// перед малими словами, тож не тягне за собою ім'я.
const NAME_TOKEN = /^[А-ЯЇІЄҐA-Z][а-яіїєґa-z'’`\-]+$/;
// Складне ім'я з дефісом («Марія-Вероніка») — велика літера після дефіса.
const COMPOUND_TOKEN = /^[А-ЯЇІЄҐA-Z][а-яіїєґa-z'’`\-]*-[А-ЯЇІЄҐA-Z][а-яіїєґa-z'’`\-]+$/;
const isName = (t) => NAME_TOKEN.test(t) || COMPOUND_TOKEN.test(t);
const DIGITS_ONLY = /^\d+$/;
const HAS_DIGIT = /\d/;
// По батькові може бути розірване на два токени («Володимирови» + «ч»).
const NAME_TAIL = /^[а-яіїєґ]{1,2}$/;

// У записі про студента: прізвище, ім'я, по батькові йдуть підряд, а перед
// ними — номер, після них — документ. Це і відрізняє ім'я від решти тексту.
function findNames(raw) {
  // Ім'я з дефісом PDF розриває на два токени («Марія-» + «Вероніка»).
  const tokens = [];
  for (let i = 0; i < raw.length; i++) {
    const last = tokens[tokens.length - 1];
    if (last && /-$/.test(last) && isName(last) && isName(raw[i])) {
      tokens[tokens.length - 1] = last + raw[i];
      continue;
    }
    tokens.push(raw[i]);
  }

  const found = [];
  let i = 0;
  while (i < tokens.length) {
    if (!isName(tokens[i])) { i++; continue; }
    let j = i;
    while (j < tokens.length && isName(tokens[j])) j++;
    let run = tokens.slice(i, j);
    if (j < tokens.length && NAME_TAIL.test(tokens[j]) && run.length >= 2) {
      run.push(tokens[j]);
      j++;
    }
    const before = tokens[i - 1] || '';
    const after = tokens[j] || '';
    if (run.length >= 2 && DIGITS_ONLY.test(before) && HAS_DIGIT.test(after)) {
      found.push({
        last_name: run[0].replace(/`/g, "'"),
        first_name: run[1].replace(/`/g, "'"),
        patronymic: (run[2] || '').replace(/`/g, "'"),
        extra: run.slice(3),
      });
      i = j;
      continue;
    }
    i = j > i ? j : i + 1;
  }
  return found;
}

async function main() {
  const posts = await wp('/posts?search=' + encodeURIComponent('зарахування') +
    '&per_page=50&after=' + SINCE + '&_fields=id,date,title,content');

  const orders = [];
  for (const p of posts) {
    const m = (p.content.rendered || '').match(/file=([^&"]+)/);
    if (!m) continue;
    const pdf = decodeURIComponent(m[1]);
    const title = p.title.rendered.replace(/<[^>]+>/g, '').trim();
    orders.push({ id: p.id, date: p.date.slice(0, 10), title, pdf: 'https://sclnau.com.ua' + pdf });
  }
  console.log('наказів з PDF:', orders.length);

  const all = [];
  for (const o of orders) {
    let lines;
    try {
      lines = await extractLines(o.pdf);
    } catch (e) {
      console.log('  ' + o.title + ' -> не вдалося прочитати: ' + e.message);
      continue;
    }
    const names = findNames(lines);
    console.log('  ' + o.title + ' (' + o.date + ') -> імен: ' + names.length);
    for (const n of names) all.push(Object.assign({ order: o.title }, n));
  }

  // Унікальні за «прізвище + ім'я» — різні накази могли перелічувати одну людину.
  const seen = new Map();
  for (const n of all) {
    const key = n.last_name + '|' + n.first_name;
    if (!seen.has(key)) seen.set(key, n);
  }
  const unique = [...seen.values()];

  console.log('\nусього імен: ' + all.length + ' | унікальних: ' + unique.length);

  if (OUT) {
    // Формат такий самий, як у rating-pdf.mjs: далі build-roster.mjs шукає
    // кожне ім'я в журналі й визначає групу.
    fs.writeFileSync(OUT, JSON.stringify({
      source: 'orders',
      parsed_at: Date.now(),
      groups: [{ letter: '', num: '', students: unique.map((n) => ({
        last_name: n.last_name, first_name: n.first_name, patronymic: n.patronymic, extra: n.extra || [],
      })) }],
    }, null, 2));
    console.log('Збережено: ' + OUT);
  }
}

await main();
