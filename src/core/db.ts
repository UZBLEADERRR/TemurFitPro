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

/// Tenant SQL fayllari:
///   tenant-init.sql       — sxemadan avtomatik (npm run sql:tenant), yangi bazalar uchun
///   tenant-migrations.sql — qo'lda yozilgan idempotent ALTER'lar, eski bazalar uchun
const sqlCache = new Map<string, string>();

function loadSql(name: string, required = true): string {
    const cached = sqlCache.get(name);
    if (cached !== undefined) return cached;

    for (const dir of [path.join(process.cwd(), 'prisma'), path.join(__dirname, '..', '..', 'prisma')]) {
        const file = path.join(dir, name);
        if (fs.existsSync(file)) {
            const content = fs.readFileSync(file, 'utf8');
            sqlCache.set(name, content);
            return content;
        }
    }

    if (required) throw new Error(`prisma/${name} topilmadi — \`npm run sql:tenant\` ni ishga tushiring`);
    sqlCache.set(name, '');
    return '';
}

/// SQL faylni buyruqlarga bo'lish.
///
/// Izohlar AVVAL olib tashlanadi, keyin `;` bo'yicha bo'linadi. Teskarisi qilinsa,
/// izoh ichidagi nuqtali vergul matnni bo'lib yuboradi va izohning qolgan qismi
/// SQL bo'lib qoladi.
function statements(sql: string): string[] {
    const withoutComments = sql
        .split('\n')
        .filter(line => !line.trim().startsWith('--'))
        .join('\n');

    return withoutComments
        .split(';')
        .map(chunk => chunk.trim())
        .filter(Boolean);
}

async function applySchema(client: TenantClient): Promise<void> {
    // SQLite bir vaqtda bitta yozuvchini qabul qiladi. WAL rejimi o'quvchilarni
    // yozuvchi bilan bloklanishdan qutqaradi; busy_timeout esa qisqa kutishlarda
    // "database is locked" xatosi o'rniga kutib turishni tanlaydi.
    // PRAGMA natija qatori qaytaradi — shuning uchun $queryRawUnsafe.
    for (const pragma of ['PRAGMA journal_mode = WAL', 'PRAGMA busy_timeout = 5000', 'PRAGMA foreign_keys = ON']) {
        await client.$queryRawUnsafe(pragma).catch(() => undefined);
    }

    // Tartib MUHIM: jadval → ustun qo'shish → indeks.
    // Indeks yangi ustun ustida bo'lishi mumkin (masalan Group(isActive, status)).
    // Uni ALTER'dan oldin yaratishga urinsak, eski bazada "no such column" chiqib
    // bot umuman ishga tushmay qoladi.
    const initStatements = statements(loadSql('tenant-init.sql'));
    const isIndex = (s: string) => /^CREATE\s+(UNIQUE\s+)?INDEX/i.test(s);

    // 1) Jadvallarni yaratish (mavjud bo'lsa tegmaydi)
    for (const stmt of initStatements.filter(s => !isIndex(s))) {
        await client.$executeRawUnsafe(stmt.replace(/^CREATE TABLE "/i, 'CREATE TABLE IF NOT EXISTS "'));
    }

    // 2) Eski bazalarga yetishmayotgan ustunlarni qo'shish.
    // ALTER'ni ko'r-ko'rona bajarib xatoni yutish ham mumkin edi, lekin u holda
    // Prisma har ishga tushishda konsolga qizil "duplicate column" yozadi va
    // haqiqiy nosozlikni ko'rish qiyinlashadi. Shuning uchun avval tekshiramiz.
    const added: string[] = [];

    for (const stmt of statements(loadSql('tenant-migrations.sql', false))) {
        const add = /^ALTER\s+TABLE\s+"([^"]+)"\s+ADD\s+COLUMN\s+"([^"]+)"/i.exec(stmt);
        if (add && (await hasColumn(client, add[1], add[2]))) continue;

        try {
            await client.$executeRawUnsafe(stmt);
            if (add) {
                added.push(`${add[1]}.${add[2]}`);
                log.info('db', `ustun qo'shildi: ${add[1]}.${add[2]}`);
            }
        } catch (e) {
            if (String(e).toLowerCase().includes('duplicate column')) continue;
            log.warn('db', `migratsiya o'tmadi: ${stmt.slice(0, 60)}… — ${String(e).slice(0, 160)}`);
        }
    }

    // 3) Indekslar — endi yangi ustunlar mavjud
    for (const stmt of initStatements.filter(isIndex)) {
        const safe = stmt
            .replace(/^CREATE UNIQUE INDEX "/i, 'CREATE UNIQUE INDEX IF NOT EXISTS "')
            .replace(/^CREATE INDEX "/i, 'CREATE INDEX IF NOT EXISTS "');
        try {
            await client.$executeRawUnsafe(safe);
        } catch (e) {
            // Indeks yaratilmasa ishlash sekinlashadi, lekin bot to'xtamasligi kerak
            log.warn('db', `indeks yaratilmadi: ${safe.slice(0, 70)}… — ${String(e).slice(0, 120)}`);
        }
    }

    // 4) Ustun endi qo'shilgan bo'lsa — eski qatorlarni to'ldirish.
    // Bu shart MUHIM: ustun qo'shilgani "bu baza yangilanishdan oldin ishlab
    // turgan edi" degani. Yangi bazada ustun tenant-init.sql da bor, ALTER
    // o'tkazib yuboriladi va backfill ham ishlamaydi.
    for (const key of added) {
        for (const stmt of AFTER_COLUMN_ADDED[key] ?? []) {
            try {
                const n = await client.$executeRawUnsafe(stmt);
                log.info('db', `${key} uchun to'ldirildi: ${n} qator`);
            } catch (e) {
                log.warn('db', `to'ldirish o'tmadi (${key}): ${String(e).slice(0, 160)}`);
            }
        }
    }
}

/// Ustun QO'SHILGANDA (ya'ni faqat eski bazalarda) bajariladigan to'ldirishlar.
///
/// Sanaga qarab filtrlashga urinmang: Prisma SQLite'da DateTime'ni son sifatida
/// saqlaydi, SQLite'da esa son har doim matndan kichik — `createdAt < '2026-08-16'`
/// kabi shart HAMMA qatorga to'g'ri keladi va yangi yozuvlarni ham o'zgartirib yuboradi.
const AFTER_COLUMN_ADDED: Record<string, string[]> = {
    // Guruh tasdiqlash joriy qilinishidan oldin mavjud guruhlar allaqachon
    // ishlab turgan edi — ularni qayta tasdiqlatish botlarni to'xtatib qo'yardi.
    'Group.status': [`UPDATE "Group" SET "status" = 'approved', "approvedAt" = CURRENT_TIMESTAMP`],
};

async function hasColumn(client: TenantClient, table: string, column: string): Promise<boolean> {
    try {
        const rows = await client.$queryRawUnsafe<Array<{ name: string }>>(
            `PRAGMA table_info("${table.replace(/"/g, '')}")`,
        );
        return rows.some(r => r.name === column);
    } catch {
        return false;
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
