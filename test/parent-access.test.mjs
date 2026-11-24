// Відлік доступу за QR — це те, що людина бачить щодня: якщо він збреше,
// журнал або «минув» зарано, або висить мертвим. Функції живуть у app.js —
// це класичний браузерний скрипт, який не можна імпортувати з Node, тож
// витягуємо текст функцій з файлу й перевіряємо саме їх, а не копію.
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../app.js', import.meta.url), 'utf8');

let failed = 0;
function check(name, actual, expected) {
  const ok = String(actual) === String(expected);
  if (!ok) failed++;
  console.log((ok ? 'OK   ' : 'FAIL ') + name);
  if (!ok) console.log('  очікувалося: ' + expected + '\n  отримано:   ' + actual);
}

function grab(name, params) {
  const re = new RegExp('\\nfunction ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}');
  const found = re.exec(src);
  if (!found) {
    console.log('FAIL у app.js немає функції ' + name);
    process.exit(1);
  }
  return new Function(...params, 'return (' + found[0] + ')');
}

const SOON = 5 * 60 * 1000;
const session = grab('parentSession', ['state', 'ACCESS_SOON_MS', 'Date']);
const leftText = grab('leftText', [])();
const labelFrom = grab('labelFromJournal', [])();

// Date підміняємо, щоб відлік не залежав від того, коли запустили тест.
const at = (now) => ({ now: () => now });
const S = (over) => Object.assign({ parentToken: 't', parentExpiresAt: 0, parentTtl: 0 }, over);
const NOW = 1_800_000_000_000;

let s = session(S({ parentToken: null }), SOON, at(NOW))();
check('без токена — доступу немає', s.status, 'none');
check('без токена — строк невідомий', s.known, false);

s = session(S({ parentToken: 't', parentExpiresAt: 0 }), SOON, at(NOW))();
check('кабінет не дав строку — не вигадуємо його', s.known, false);
check('кабінет не дав строку — доступ активний', s.status, 'ok');
check('без строку шкала повна', s.pct, 100);

s = session(S({ parentExpiresAt: NOW + 420_000, parentTtl: 600 }), SOON, at(NOW))();
check('7 хв із 10 — активний', s.status, 'ok');
check('7 хв із 10 — шкала 70%', s.pct, 70);
check('7 хв із 10 — залишок', s.left, 420_000);

// Поріг «завершується» — менше з 5 хв і чверті строку: для короткого доступа
// попереджати за 5 хвилин означало б попереджати одразу при активації.
s = session(S({ parentExpiresAt: NOW + 150_000, parentTtl: 600 }), SOON, at(NOW))();
check('рівно чверть строку — уже завершується', s.status, 'soon');
s = session(S({ parentExpiresAt: NOW + 151_000, parentTtl: 600 }), SOON, at(NOW))();
check('на секунду більше чверті — ще активний', s.status, 'ok');
s = session(S({ parentExpiresAt: NOW + 299_000, parentTtl: 86_400 }), SOON, at(NOW))();
check('добовий доступ: 4 хв 59 с — завершується', s.status, 'soon');
s = session(S({ parentExpiresAt: NOW + 301_000, parentTtl: 86_400 }), SOON, at(NOW))();
check('добовий доступ: 5 хв 1 с — ще активний', s.status, 'ok');

s = session(S({ parentExpiresAt: NOW, parentTtl: 600 }), SOON, at(NOW))();
check('строк вийшов рівно зараз — минув', s.status, 'expired');
check('минулий доступ — шкала нуль', s.pct, 0);
s = session(S({ parentExpiresAt: NOW - 5000, parentTtl: 600 }), SOON, at(NOW))();
check('строк вийшов давно — минув', s.status, 'expired');
check('минулий доступ — залишок нуль', s.left, 0);

s = session(S({ parentExpiresAt: NOW + 600_000, parentTtl: 0 }), SOON, at(NOW))();
check('без відомого строку шкала не виходить за 100%', s.pct, 100);
s = session(S({ parentExpiresAt: NOW + 9_999_000, parentTtl: 600 }), SOON, at(NOW))();
check('залишок більший за строк — шкала обмежена', s.pct, 100);

check('нуль — це нуль секунд', leftText(0), '0 с');
check('від’ємне не показуємо', leftText(-5000), '0 с');
check('дроби округлюємо вгору', leftText(1500), '2 с');
check('59 секунд', leftText(59_000), '59 с');
check('рівно хвилина', leftText(60_000), '1 хв 00 с');
check('півтори хвилини', leftText(90_000), '1 хв 30 с');
check('рівно година', leftText(3_600_000), '1 год 00 хв');
check('півтори години', leftText(5_400_000), '1 год 30 хв');
check('доба', leftText(86_400_000), '1 дн 0 год');
check('доба й година', leftText(90_000_000), '1 дн 1 год');

check('ім’я з об’єкта student', labelFrom({ student: { full_name: 'Іван Петренко', group: 'П-21' } }), 'Іван Петренко · П-21');
check('ім’я без групи', labelFrom({ full_name: 'Іван Петренко' }), 'Іван Петренко');
check('ім’я з двох полів', labelFrom({ first_name: 'Іван', last_name: 'Петренко' }), 'Іван Петренко');
check('інші назви полів', labelFrom({ student_name: 'Олена', group_name: 'К-22' }), 'Олена · К-22');
check('лише ім’я', labelFrom({ student: { first_name: 'Іван' } }), 'Іван');
check('порожня відповідь', labelFrom({}), '');
check('журнал без імені', labelFrom({ journal: [] }), '');
check('нічого немає', labelFrom(null), '');
check('рядок замість об’єкта', labelFrom('Іван'), '');

// saveParent вирішує, коли доступ стане минулим. Запас проти годинника пристрою
// не має з'їдати весь строк, якщо кабінет видав короткого токена.
const LS = { parentToken: 'ep_parent_token', parentExpires: 'ep_parent_expires', parentTtl: 'ep_parent_ttl', journalParent: 'ep_journal_parent' };
const saveParent = grab('saveParent', ['state', 'localStorage', 'LS', 'Date', 'setParentLabel', 'resyncPush']);

function save(expiresIn, prevToken) {
  const store = new Map();
  if (prevToken) store.set(LS.journalParent, '{"t":1,"d":{}}');
  const st = { parentToken: prevToken || null, parentTtl: 0, parentExpiresAt: 0 };
  const fn = saveParent(st, {
    setItem: (k, v) => store.set(k, v),
    removeItem: (k) => store.delete(k),
  }, LS, at(NOW), () => { }, () => { });
  fn({ token: 'new-token', expiresIn });
  return { st, store };
}

let r = save(900, null);
check('15 хв строку — запас хвилина', r.st.parentExpiresAt - NOW, 840_000);
check('строк записано в пам’ять пристрою', r.store.get(LS.parentExpires), String(NOW + 840_000));
check('токен записано в пам’ять пристрою', r.store.get(LS.parentToken), 'new-token');

r = save(30, null);
check('короткий строк не стає минулим одразу', r.st.parentExpiresAt > NOW, true);
check('30 с строку — запас 3 с', r.st.parentExpiresAt - NOW, 27_000);

r = save(600, null);
check('10 хв строку — запас 60 с', r.st.parentExpiresAt - NOW, 540_000);

r = save(null, null);
check('кабінет не дав строку — нуль, а не вигадана дата', r.st.parentExpiresAt, 0);
r = save(0, null);
check('нульовий строк — нуль', r.st.parentExpiresAt, 0);

r = save(900, 'old-token');
check('новий токен стирає кеш попереднього журналу', r.store.has(LS.journalParent), false);
check('новий токен лишає свіжий строк', r.st.parentExpiresAt - NOW, 840_000);

console.log(failed ? '\n' + failed + ' перевірок впало' : '\nУсі перевірки пройдено');
process.exit(failed ? 1 : 0);