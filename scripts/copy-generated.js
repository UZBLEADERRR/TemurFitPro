// Prisma klientlari src/generated ichiga yaratiladi va ular TAYYOR .js fayllar —
// tsc ularni ko'chirmaydi (u faqat .ts ni o'giradi). Shuning uchun yig'ilgandan
// keyin dist/generated ga qo'lda ko'chiramiz, aks holda `node dist/index.js`
// "Cannot find module '../generated/platform'" deb yiqiladi.
const fs = require('fs');
const path = require('path');

const from = path.join(__dirname, '..', 'src', 'generated');
const to = path.join(__dirname, '..', 'dist', 'generated');

if (!fs.existsSync(from)) {
    console.error('[copy-generated] src/generated topilmadi — avval `npm run generate`');
    process.exit(1);
}

fs.rmSync(to, { recursive: true, force: true });
fs.cpSync(from, to, { recursive: true });
console.log(`[copy-generated] ${path.relative(process.cwd(), to)} tayyor`);
