// Накази про зарахування на І курс -> список ПІБ із спеціальністю.
//
// Накази коледжу лежать як WP-пости з PDF-вкладенням. У PDF немає групи —
// лише спеціальність, ПІБ і конкурсний бал. Групу дає журнальний API:
// запит «group + прізвище + ім'я» повертає 200 лише для справжнього студента.
//
// Запуск: node scripts/orders-pdf.mjs [--out file.json]

import fs from 'node:fs';
import { extractLines } from './pdf-text.mjs';
import { findNames } from './orders-parse.mjs';

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
  const bySpec = new Map();
  for (const n of unique) bySpec.set(n.specialty, (bySpec.get(n.specialty) || 0) + 1);
  for (const [s, c] of [...bySpec].sort((a, b) => b[1] - a[1])) console.log('  ' + String(c).padStart(4) + '  ' + s);

  if (OUT) {
    // Формат такий самий, як у rating-pdf.mjs: далі build-roster.mjs шукає
    // кожне ім'я в журналі й визначає групу.
    fs.writeFileSync(OUT, JSON.stringify({
      source: 'orders',
      parsed_at: Date.now(),
      groups: [{ letter: '', num: '', students: unique.map((n) => ({
        last_name: n.last_name, first_name: n.first_name, patronymic: n.patronymic,
        specialty: n.specialty, extra: n.extra || [],
      })) }],
    }, null, 2));
    console.log('\nЗбережено: ' + OUT);
  }
}

await main();
