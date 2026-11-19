// Ishga tushishdan oldin: ma'lumotlar papkasini yaratish va platforma bazasini
// sxemaga moslash. Tenant bazalari runtime'da prisma/tenant-init.sql orqali
// yaratiladi — ular uchun Prisma CLI kerak emas.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const { resolveDataDir } = require('./data-dir.cjs');

let dataDir;
try {
    dataDir = resolveDataDir();
} catch (e) {
    console.error(`\n[prestart] ${e.message}\n`);
    process.exit(1);
}

try {
    fs.mkdirSync(path.join(dataDir, 'tenants'), { recursive: true });
} catch (e) {
    console.error(`[prestart] ${dataDir} yaratilmadi: ${e.message}`);
    console.error('[prestart] Railway\'da Volume qo\'shing va DATA_DIR ni mount path\'ga tenglang.');
    process.exit(1);
}

const platformUrl = `file:${path.join(dataDir, 'platform.db')}`;
console.log(`[prestart] platforma bazasi: ${platformUrl}`);

execFileSync(
    'npx',
    // --accept-data-loss ATAYLAB yo'q: u sxemadan olib tashlangan ustunni
    // so'ramasdan o'chirib yuboradi. Bunday o'zgarish kerak bo'lsa deploy
    // yiqilsin va biz uni qo'lda ko'rib chiqaylik.
    ['prisma', 'db', 'push', '--schema', 'prisma/platform.prisma', '--skip-generate'],
    { stdio: 'inherit', env: { ...process.env, PLATFORM_DATABASE_URL: platformUrl } },
);
