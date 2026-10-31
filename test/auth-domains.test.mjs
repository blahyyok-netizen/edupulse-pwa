// Перевірка правила Firebase для доменів: сам домен і піддомени збігаються,
// інші — ні; порожній перелік означає «невідомо», тоді вхід не блокуємо.
// Запуск: node test/auth-domains.test.mjs

import { domainAllowed } from '../auth-domains.mjs';

let failed = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failed++;
  console.log((ok ? 'OK   ' : 'FAIL ') + name);
  if (!ok) {
    console.log('  очікувалося: ' + expected);
    console.log('  отримано:   ' + actual);
  }
}

const LIST = ['localhost', 'edupulse-main.firebaseapp.com', 'edupulse-main.web.app'];

check('домен із переліку', String(domainAllowed('edupulse-main.firebaseapp.com', LIST)), 'true');
check('локальний розробник', String(domainAllowed('localhost', LIST)), 'true');
check('піддомен дозволеного домену', String(domainAllowed('sub.edupulse-main.web.app', LIST)), 'true');
check('глибокий піддомен', String(domainAllowed('a.b.edupulse-main.firebaseapp.com', LIST)), 'true');
check('чужий домен', String(domainAllowed('edupulse-pwa.olehnana1236.workers.dev', LIST)), 'false');
check('домен, що лише містить дозволений', String(domainAllowed('notedupulse-main.web.app', LIST)), 'false');
check('регістр не важливий', String(domainAllowed('EDUPulse-Main.Web.App', LIST)), 'true');
check('перелік порожній — невідомо', String(domainAllowed('edupulse-main.web.app', [])), 'null');
check('перелік відсутній — невідомо', String(domainAllowed('edupulse-main.web.app', null)), 'null');
check('без хоста — невідомо', String(domainAllowed('', LIST)), 'null');

console.log(failed ? '\n' + failed + ' перевірок впало' : '\nУсі перевірки пройдено');
process.exit(failed ? 1 : 0);
