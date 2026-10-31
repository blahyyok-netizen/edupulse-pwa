// Правило Firebase для перевірки домену: «^(.+\.<домен>|<домен>)$» —
// збігається сам домен і будь-який його піддомен.
//
// null — перелік невідомий (тоді вхід не блокуємо, хай вирішує сам Firebase).

export function domainAllowed(host, list) {
  const h = String(host || '').toLowerCase();
  if (!h || !Array.isArray(list) || !list.length) return null;
  for (const item of list) {
    const d = String(item || '').toLowerCase();
    if (!d) continue;
    if (h === d || h.endsWith('.' + d)) return true;
  }
  return false;
}
