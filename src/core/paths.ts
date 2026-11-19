import fs from 'fs';
import path from 'path';

/// Barcha ma'lumotlar Railway Volume ichidagi shu papkada yotadi.
///
/// Joyni scripts/data-dir.cjs hal qiladi — prestart.js ham aynan o'sha
/// moduldan oladi, shuning uchun ikkalasi hech qachon boshqa-boshqa
/// papkaga qaramaydi. Railway'da Volume ulanmagan bo'lsa u xato uloqtiradi.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resolveDataDir } = require('../../scripts/data-dir.cjs') as { resolveDataDir: () => string };

export const DATA_DIR: string = resolveDataDir();

export const TENANTS_DIR = path.join(DATA_DIR, 'tenants');

export function ensureDirs(): void {
    fs.mkdirSync(TENANTS_DIR, { recursive: true });
}

export function platformDbPath(): string {
    return path.join(DATA_DIR, 'platform.db');
}

/// Har bir bot uchun alohida fayl. botId ishlatiladi — u faqat raqamlardan iborat,
/// shuning uchun fayl nomi xavfsiz.
export function tenantDbPath(botId: string): string {
    if (!/^\d+$/.test(botId)) throw new Error(`Yaroqsiz botId: ${botId}`);
    return path.join(TENANTS_DIR, `${botId}.db`);
}

export function fileUrl(p: string): string {
    return `file:${p}`;
}

/// Fayl hajmi (baytlarda). WAL va shm fayllari ham qo'shiladi.
export function dbSizeBytes(p: string): number {
    let total = 0;
    for (const suffix of ['', '-wal', '-shm']) {
        try {
            total += fs.statSync(p + suffix).size;
        } catch {
            /* fayl yo'q */
        }
    }
    return total;
}

export function humanSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
