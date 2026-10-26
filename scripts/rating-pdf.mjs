// Розбір PDF «Рейтинг успішності студентів» → список ПІБ по групах.
import fs from 'node:fs';
import { extractLines } from './pdf-text.mjs';

const url = process.argv[2] || 'https://sclnau.com.ua/wp-content/uploads/2026/06/RUS.pdf';
const out = process.argv[3] || '';

const lines = await extractLines(url);

// --- збір структури: блок групи -> список студентів ---
// У PDF код групи розбито на кілька рядків («Т», «-», «32»), літери іноді
// приходять двома шматками («М», «Е»), а назви спеціальностей між ними —
// шум, який треба пропустити. Літери груп у PDF розшифровуються з похибкою
// (Ȃ замість Т), тому групу підтверджуємо перевіркою через journal API.
const tokens = lines.flatMap((l) => l.split('\n')).map((s) => s.trim()).filter(Boolean);

const blocks = [];
let current = null;
for (let i = 0; i < tokens.length; i++) {
  const t = tokens[i];
  // Код групи: до 2 рядків з літерами, потім «-», потім 1-2 рядки з цифрами.
  if (tokens[i + 1] === '-' && /^[^\s\d]{1,3}$/.test(t)) {
    const digits = [];
    let j = i + 2;
    while (j < tokens.length && /^\d{1,2}$/.test(tokens[j]) && digits.length < 2) { digits.push(tokens[j]); j++; }
    if (digits.length && /^\d+\.$/.test(tokens[j] || '')) {
      const second = tokens[i - 1];
      const letter = (second && /^[^\s\d]{1,3}$/.test(second)) ? second + t : t;
      current = { letter, num: digits.join(''), students: [] };
      blocks.push(current);
      i = j - 1;
      continue;
    }
  }
  if (!current) continue;

  if (/^\d+\.$/.test(t)) {
    // ПІБ у PDF — один або кілька рядків: «Шепіда Андрій» + «Васильович».
    const names = [];
    let j = i + 1;
    while (j < tokens.length && names.length < 6) {
      const p = tokens[j];
      if (/^\d+,\d+$/.test(p)) break;
      if (/^[^\s\d].*[а-яіїєґ]/i.test(p)) names.push(...p.split(/\s+/).filter(Boolean));
      j++;
    }
    const score = (tokens[j] || '').trim();
    if (names.length >= 2 && /^\d+,\d+$/.test(score)) {
      current.students.push({
        last_name: names[0],
        first_name: names[1],
        patronymic: names[2] && names[2] !== '-' ? names[2] : '',
        score,
        extra: names.slice(3),
      });
      i = j;
    }
    continue;
  }
}

const groups = blocks.filter((b) => b.students.length);
console.log('блоків груп:', blocks.length, 'з студентами:', groups.length);
console.log('студентів:', groups.reduce((n, g) => n + g.students.length, 0));
console.log(groups.slice(0, 6).map((g) => g.letter + '-' + g.num + ' (' + g.students.length + ')').join('\n'));
console.log('...');
console.log('коди:', groups.map((g) => g.letter + '-' + g.num).join(' '));

if (out) {
  fs.writeFileSync(out, JSON.stringify({ source: url, parsed_at: Date.now(), groups }, null, 2));
  console.log('\nЗбережено: ' + out);
}
