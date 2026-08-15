import fs from 'fs';
import path from 'path';
import { PrismaClient as PlatformClient } from '../generated/platform';
import { PrismaClient as TenantClient } from '../generated/tenant';
import { DATA_DIR, TENANTS_DIR, ensureDirs, platformDbPath, tenantDbPath, fileUrl, dbSizeBytes } from './paths';
import { log } from './logger';

export type { PlatformClient, TenantClient };

ensureDirs();

// ============ PLATFORMA BAZASI ============
// Bitta kichik fayl: super adminlar + botlar ro'yxati.

export const prisma = new PlatformClient({
    datasources: { db: { url: fileUrl(platformDbPath()) } },
    log: ['error'],
});

// ============ TENANT BAZALARI ============
// Har bir bot uchun alohida fayl. Ochilgan klientlar keshda saqlanadi.

const tenantClients = new Map<string, TenantClient>();

/// Tenant DDL — birinchi marta ochilganda ishlatiladi.
/// `npm run sql:tenant` bilan sxemadan avtomatik yaratiladi.
let initSql: string | null = null;

function loadInitSql(): string {
    if (initSql !== null) return initSql;
    const candidates = [
        path.join(process.cwd(), 'prisma', 'tenant-init.sql'),
        path.join(__dirname, '..', '..', 'prisma', 'tenant-init.sql'),
    ];
    for (const c of candidates) {
        if (fs.existsSync(c)) {
            initSql = fs.readFileSync(c, 'utf8');
            return initSql;
        }
    }
    throw new Error("prisma/tenant-init.sql topilmadi — `npm run sql:tenant` ni ishga tushiring");
}

async function applySchema(client: TenantClient): Promise<void> {
    // SQLite bir vaqtda bitta yozuvchini qabul qiladi. WAL rejimi o'quvchilarni
    // yozuvchi bilan bloklanishdan qutqaradi; busy_timeout esa qisqa kutishlarda
    // "database is locked" xatosi o'rniga kutib turishni tanlaydi.
    // PRAGMA natija qatori qaytaradi — shuning uchun $queryRawUnsafe.
    for (const pragma of ['PRAGMA journal_mode = WAL', 'PRAGMA busy_timeout = 5000', 'PRAGMA foreign_keys = ON']) {
        await client.$queryRawUnsafe(pragma).catch(() => undefined);
    }

    // Fayl `-- CreateTable` izohlari bilan bo'lingan. Har bir bo'lakdan izoh
    // qatorlarini olib tashlaymiz — aks holda butun bo'lak izoh deb tashlanadi.
    const statements = loadInitSql()
        .split(';')
        .map(chunk =>
            chunk
                .split('\n')
                .filter(line => !line.trim().startsWith('--'))
                .join('\n')
                .trim(),
        )
        .filter(Boolean);

    for (const stmt of statements) {
        // IF NOT EXISTS — mavjud bazani qayta ochganda xato bermasin
        const safe = stmt
            .replace(/^CREATE TABLE "/i, 'CREATE TABLE IF NOT EXISTS "')
            .replace(/^CREATE UNIQUE INDEX "/i, 'CREATE UNIQUE INDEX IF NOT EXISTS "')
            .replace(/^CREATE INDEX "/i, 'CREATE INDEX IF NOT EXISTS "');
        await client.$executeRawUnsafe(safe);
    }
}

/// Bot uchun baza klientini olish (kerak bo'lsa faylni yaratib, sxemani qo'llaydi).
export async function tenantDb(botId: string): Promise<TenantClient> {
    const cached = tenantClients.get(botId);
    if (cached) return cached;

    const dbPath = tenantDbPath(botId);
    const isNew = !fs.existsSync(dbPath);

    const client = new TenantClient({
        datasources: { db: { url: fileUrl(dbPath) } },
        log: ['error'],
    });

    await applySchema(client);
    tenantClients.set(botId, client);

    if (isNew) log.info('db', `yangi tenant bazasi yaratildi: ${dbPath}`);
    return client;
}

/// Klientni yopish (fayl o'chirilishidan oldin shart).
export async function closeTenantDb(botId: string): Promise<void> {
    const client = tenantClients.get(botId);
    if (!client) return;
    tenantClients.delete(botId);
    await client.$disconnect().catch(() => undefined);
}

/// Botning butun bazasini o'chirish — bitta fayl (va WAL sheriklari) yo'qoladi.
export async function dropTenantDb(botId: string): Promise<void> {
    await closeTenantDb(botId);
    const dbPath = tenantDbPath(botId);
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
        try {
            fs.unlinkSync(dbPath + suffix);
        } catch {
            /* fayl yo'q */
        }
    }
    log.info('db', `tenant bazasi o'chirildi: ${dbPath}`);
}

/// Bot bazasi qancha joy egallaganini ko'rsatish (xarajatni kuzatish uchun).
export function tenantDbSize(botId: string): number {
    try {
        return dbSizeBytes(tenantDbPath(botId));
    } catch {
        return 0;
    }
}

/// Bo'shatilgan joyni diskka qaytarish (ko'p o'chirishdan keyin).
export async function vacuumTenantDb(botId: string): Promise<void> {
    const client = tenantClients.get(botId);
    if (!client) return;
    await client.$executeRawUnsafe('VACUUM').catch(e => log.warn('db', `VACUUM xatosi: ${e}`));
}

export async function disconnectAll(): Promise<void> {
    for (const [botId] of tenantClients) await closeTenantDb(botId);
    await prisma.$disconnect().catch(() => undefined);
}

export { DATA_DIR, TENANTS_DIR };
