// Генерація пари ключів VAPID.
// Запуск: npm run vapid:gen
//
// Публічний ключ — у worker.js (він і так публічний).
// Приватний — у секреті воркера: npx wrangler secret put VAPID_PRIVATE_KEY

import { generateVapidKeys } from '../webpush.js';

const keys = await generateVapidKeys();
console.log('Публічний ключ (у worker.js):');
console.log(keys.publicKey);
console.log('');
console.log('Приватний ключ (у секрет воркера, не в git):');
console.log(keys.privateKey);
