import fs from 'fs';
import path from 'path';

/// Barcha ma'lumotlar Railway Volume ichidagi shu papkada yotadi.
/// Railway avtomatik RAILWAY_VOLUME_MOUNT_PATH beradi; lokalda ./data ishlatiladi.
export const DATA_DIR =
    process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.resolve(process.cwd(), 'data');

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
