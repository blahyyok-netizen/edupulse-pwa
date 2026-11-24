// Що саме коледж клад у QR — невідомо, поки не скануєш справжній код, тому
// розбираємо всі правдоподібні форми. qrTokenFrom живе в app.js — це класичний
// браузерний скрипт, який не можна імпортувати з Node, тож витягуємо текст
// функції з файлу й перевіряємо саме його, а не копію.
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const found = /\nfunction qrTokenFrom\(raw\) \{[\s\S]*?\n\}/.exec(src);

let failed = 0;
function check(name, actual, expected) {
  const ok = String(actual) === String(expected);
  if (!ok) failed++;
  console.log((ok ? 'OK   ' : 'FAIL ') + name);
  if (!ok) console.log('  очікувалося: ' + expected + '\n  отримано:   ' + actual);
}

if (!found) {
  console.log('FAIL у app.js немає функції qrTokenFrom');
  process.exit(1);
}
const qrTokenFrom = new Function('return (' + found[0] + ')')();

check('голий токен', qrTokenFrom('abc-123'), 'abc-123');
check('пробіли навколо', qrTokenFrom('  abc-123 \n'), 'abc-123');
check('JSON із qr_token', qrTokenFrom('{"qr_token":"abc-123","expires_in_seconds":180}'), 'abc-123');
check('JSON із token', qrTokenFrom('{"token":"abc-123"}'), 'abc-123');
check('JSON із code', qrTokenFrom('{"code":"abc-123"}'), 'abc-123');
check('JSON без відомих полів', qrTokenFrom('{"foo":1}'), '');
check('посилання з параметром', qrTokenFrom('https://tt.sclnau.com.ua/parent?qr_token=abc-123'), 'abc-123');
check('посилання з параметром після геша', qrTokenFrom('https://x/#/parent?code=abc-123'), 'abc-123');
check('кодування у параметрі', qrTokenFrom('https://x/?qr_token=a%2Fb'), 'a/b');
check('токен у шляху', qrTokenFrom('https://x/parent/qr/abc-123'), 'abc-123');
check('хеш не потрапляє в код', qrTokenFrom('https://x/parent/qr/abc-123#tail'), 'abc-123');
check('порожній рядок', qrTokenFrom(''), '');
check('нічого немає', qrTokenFrom(null), '');
// «%» без двох шістнадцяткових цифр — це URIError у decodeURIComponent.
// Кнопка «Відкрити журнал» не має мовчки вмирати через такий рядок.
check('пошкоджене кодування в параметрі', qrTokenFrom('https://x/?qr_token=abc%'), 'abc%');
check('невірні шістнадцяткові цифри', qrTokenFrom('https://x/parent/qr/a%zzb'), 'a%zzb');
check('кодування пробілу', qrTokenFrom('https://x/?qr_token=abc%20def'), 'abc def');
check('відсоток у голому рядку', qrTokenFrom('abc%def'), 'abc%def');

console.log(failed ? '\n' + failed + ' перевірок впало' : '\nУсі перевірки пройдено');
process.exit(failed ? 1 : 0);
