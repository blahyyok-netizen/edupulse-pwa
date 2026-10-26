// Склад груп першого курсу: з наказів про зарахування коледжу.
//
// Накази — єдине публічне джерело, де перелічено студентів першого курсу:
// журнальний API вміє лише пошук «група + прізвище + ім'я» і списку групи
// не віддає.
//
// Група студента береться з його спеціальності: літера в коді групи — це цикл
// коледжу. Відповідність перевірена на минулорічному наборі (накази 2025 року
// та рейтинговий PDF коледжу): Будівництво -> Б-11, Дизайн -> Д-11/Д-12,
// Комп'ютерні науки -> К-11/К-12, Правнича -> С-11, Туризм -> Р-11,
// Фінанси -> УФ-11, Експлуатація -> М-11, Електроенергетика -> Е-11,
// Обслуговування авто -> Т-11.
//
// Дві спеціальності діляться на дві групи (К-11/К-12 та Д-11/Д-12). Поділ не
// виводиться з наказу — ні за алфавітом, ні за конкурсним балом, ні за ID
// заяви; його дає журнальний API. Тож ці студенти лишаються на підтвердження.
//
// Запуск: node scripts/first-years.mjs [--orders 221,227] [--out file.json]
//        [--scan file.json] [--write]

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { extractLines } from './pdf-text.mjs';
import { findNames } from './orders-parse.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const arg = (name, def) => (args.includes(name) ? args[args.indexOf(name) + 1] : def);
const OUT = arg('--out', '');
const SCAN = arg('--scan', '');
const WRITE = args.includes('--write');
const WP = 'https://sclnau.com.ua/wp-json/wp/v2';
const HEADERS = { 'user-agent': 'okhttp/4.12.0' };
const SINCE = '2026-07-01T00:00:00';

// Накази, з яких набирають першокурсники 2026/27 навчального року. Визначено
// за згадками коледжу про групи (Стеців Ростислав і Тунський Маркіян -> К-12,
// Лисенко Володимир -> М-11, Мицак Софія і Микієвич Євгенія -> Р-11) та за
// аналогом із минулим роком: перші два накази серпня — це першокурсники,
// решта — студенти старших курсів і заочної форми.
const DEFAULT_ORDERS = ['221', '227'];
const ORDERS = arg('--orders', DEFAULT_ORDERS.join(',')).split(',').map((s) => s.trim()).filter(Boolean);

// Спеціальність -> групи першого курсу. Ключ нормалізований: без пробілів і
// знаків (PDF розриває слова з апострофом, напр. «Комп ' ютерні»).
const SPECIALTY_GROUPS = {
  'компютернінаукитаінформаційнітехнології': ['К-11', 'К-12'],
  'дизайнсередовища': ['Д-11', 'Д-12'],
  'правничадіяльність': ['С-11'],
  'будівництвотацивільнаінженерія': ['Б-11'],
  'електроенергетикаелектротехнікатаелектромеханіка': ['Е-11'],
  'експлуатаціятаремонтмашиніобладнанняагропромисловоговиробництва': ['М-11'],
  'обслуговуваннятаремонтавтомобілівідвигунів': ['Т-11'],
  'туризмірекреація': ['Р-11'],
  'фінансибанківськасправастрахуваннятафондовийринок': ['УФ-11'],
  'менеджменторганізацій': ['УФ-11'],
  // Назва спеціальності 2025 року — для наступних наборів.
  'агроінженерія': ['М-11'],
};

const norm = (s) => (s || '').toLowerCase().replace(/[^a-zа-яіїєґ]/gi, '');

async function wpOrders() {
  const res = await fetch(WP + '/posts?search=' + encodeURIComponent('зарахування') +
    '&per_page=50&after=' + SINCE + '&_fields=id,date,title,content', { headers: HEADERS });
  if (!res.ok) throw new Error('WP HTTP ' + res.status);
  const posts = await res.json();
  const out = [];
  for (const p of posts) {
    const num = (p.title.rendered.match(/№\s*(\d+)/) || [])[1];
    if (!num || !ORDERS.includes(num)) continue;
    const m = (p.content.rendered || '').match(/file=([^&"]+)/);
    if (!m) continue;
    out.push({ num, date: p.date.slice(0, 10), pdf: 'https://sclnau.com.ua' + decodeURIComponent(m[1]) });
  }
  return out;
}

const students = [];
for (const o of await wpOrders()) {
  const lines = await extractLines(o.pdf);
  const day = lines.filter((l) => l === 'Денна').length;
  const extramural = lines.filter((l) => l === 'Заочна').length;
  if (extramural > day) {
    console.log('наказ ' + o.num + ' — заочна форма, пропускаємо');
    continue;
  }
  const names = findNames(lines);
  console.log('наказ ' + o.num + ' (' + o.date + ') — студентів: ' + names.length);
  for (const n of names) students.push({ ...n, order: o.num });
}

// Група кожного студента — за спеціальністю.
const byGroup = new Map();
const pending = [];
const unknownSpecialty = new Map();
for (const s of students) {
  const key = norm(s.specialty);
  const groups = SPECIALTY_GROUPS[key];
  if (!groups) {
    unknownSpecialty.set(s.specialty, (unknownSpecialty.get(s.specialty) || 0) + 1);
    continue;
  }
  s.groups = groups;
  if (groups.length === 1) {
    if (!byGroup.has(groups[0])) byGroup.set(groups[0], []);
    byGroup.get(groups[0]).push(s);
  } else {
    pending.push(s);
  }
}

console.log('\nГрупи першого курсу (спеціальність -> група):');
for (const [code, list] of [...byGroup].sort((a, b) => a[0].localeCompare(b[0], 'uk'))) {
  console.log('  ' + code.padEnd(7) + String(list.length).padStart(4) + ' студ.');
}
console.log('  очікують поділу журналом (2 групи на спеціальність): ' + pending.length);
if (unknownSpecialty.size) {
  console.log('\nНевідомі спеціальності:');
  for (const [sp, n] of unknownSpecialty) console.log('  ' + n + ' — ' + sp);
}

const outData = {
  source: 'orders',
  parsed_at: Date.now(),
  orders: ORDERS,
  groups: [...byGroup].map(([code, list]) => ({
    code,
    students: list.map((s) => ({
      last_name: s.last_name, first_name: s.first_name,
      patronymic: s.patronymic, specialty: s.specialty, score: s.score,
    })),
  })),
  pending: pending.map((s) => ({
    last_name: s.last_name, first_name: s.first_name, patronymic: s.patronymic,
    specialty: s.specialty, score: s.score, groups: s.groups,
  })),
};
if (OUT) {
  writeFileSync(OUT, JSON.stringify(outData, null, 2));
  console.log('\nЗбережено: ' + OUT);
}

// Вхід для скану журналу: усіх студентів першого курсу, з кандидатними
// групами їхньої спеціальності. Скан підтвердить групу й розділить ті
// спеціальності, що діляться на дві групи.
if (SCAN) {
  const scanData = {
    source: 'orders',
    parsed_at: Date.now(),
    groups: [{
      letter: '', num: '',
      students: [...students].filter((s) => s.groups).map((s) => ({
        last_name: s.last_name, first_name: s.first_name, patronymic: s.patronymic,
        specialty: s.specialty, score: s.score, groups: s.groups,
      })),
    }],
  };
  writeFileSync(SCAN, JSON.stringify(scanData, null, 2));
  console.log('Вхід для скану: ' + SCAN + ' (' + scanData.groups[0].students.length + ' студ.)');
}

if (WRITE && byGroup.size) {
  const now = Date.now();
  const sql = ["DELETE FROM group_students WHERE source = 'наказ';"];
  const values = [];
  for (const [code, list] of byGroup) {
    for (const s of list) {
      values.push('(' + JSON.stringify(code) + ',NULL,' + JSON.stringify(s.last_name) + ',' +
        JSON.stringify(s.first_name) + ",'наказ'," + now + ')');
    }
  }
  // Наявні рядки (підтверджені журналом) не перезаписуємо — вони точніші.
  sql.push('INSERT OR IGNORE INTO group_students (group_code, student_id, last_name, first_name, source, found_at) VALUES\n' +
    values.join(',\n') + ';');
  const sqlFile = process.env.TEMP + '/first-years.sql';
  writeFileSync(sqlFile, sql.join('\n'));
  const cmd = spawnSync('npx', ['wrangler', 'd1', 'execute', 'DB', '--remote', '--file=' + sqlFile], {
    cwd: ROOT, encoding: 'utf8', shell: true,
  });
  console.log('\nЗапис у D1: ' + (cmd.status === 0 ? 'ок' : 'помилка\n' + cmd.stdout + cmd.stderr));
}
