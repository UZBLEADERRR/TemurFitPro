// Ishga tushishdan oldin: ma'lumotlar papkasini yaratish va platforma bazasini
// sxemaga moslash. Tenant bazalari runtime'da prisma/tenant-init.sql orqali
// yaratiladi — ular uchun Prisma CLI kerak emas.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const dataDir = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || '/data';

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
    ['prisma', 'db', 'push', '--schema', 'prisma/platform.prisma', '--skip-generate', '--accept-data-loss'],
    { stdio: 'inherit', env: { ...process.env, PLATFORM_DATABASE_URL: platformUrl } },
);
