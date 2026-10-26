// Розбір PDF «наказу про зарахування» -> список ПІБ із спеціальністю.
//
// Спільний модуль для scripts/orders-pdf.mjs і перевірок.

export const NAME_TOKEN = /^[А-ЯЇІЄҐA-Z][а-яіїєґa-z'’`\-]+$/;
// Складне ім'я з дефісом («Марія-Вероніка») — велика літера після дефіса.
export const COMPOUND_TOKEN = /^[А-ЯЇІЄҐA-Z][а-яіїєґa-z'’`\-]*-[А-ЯЇІЄҐA-Z][а-яіїєґa-z'’`\-]+$/;
const isName = (t) => NAME_TOKEN.test(t) || COMPOUND_TOKEN.test(t);
const DIGITS_ONLY = /^\d+$/;
const HAS_DIGIT = /\d/;
// По батькові може бути розірване на два токени («Володимирови» + «ч»).
const NAME_TAIL = /^[а-яіїєґ]{1,2}$/;
const SCORE = /^\d+,\d+$/;
// Вид документа в лівій частині запису — далі йде назва освітньої програми.
const DOC_KIND = /(базової середньої освіти|повної загальної середньої освіти|про повну загальну середню освіту|загальну середню освіту|середню освіту)/;

export function cleanSpecialty(raw) {
  const parts = raw.split(DOC_KIND);
  return parts[parts.length - 1]
    .trim()
    .replace(/^\d{4}р\.\s*-\s*\d+\s*/, '')
    .trim();
}

// У записі про студента: прізвище, ім'я, по батькові йдуть підряд, а перед
// ними — номер, після них — документ. Це і відрізняє ім'я від ресті тексту.
export function findNames(raw) {
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
      // Далі — вид документа, потім освітня програма і конкурсний бал.
      let k = j;
      while (k < tokens.length && !SCORE.test(tokens[k])) k++;
      let doc = k;
      while (doc > j && !/^(Свідоцтво|Атестат|Диплом)/.test(tokens[doc])) doc--;
      found.push({
        last_name: run[0].replace(/`/g, "'"),
        first_name: run[1].replace(/`/g, "'"),
        patronymic: (run[2] || '').replace(/`/g, "'"),
        specialty: cleanSpecialty(tokens.slice(doc + 1, k).join(' ')),
        score: (tokens[k] || '').replace(',', '.'),
        extra: run.slice(3),
      });
      i = j;
      continue;
    }
    i = j > i ? j : i + 1;
  }
  return found;
}
