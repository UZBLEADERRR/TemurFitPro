import zlib from 'zlib';
import type { Tenant } from '../generated/platform';
import { prisma, tenantDb, vacuumTenantDb } from '../core/db';
import { log } from '../core/logger';
import { audit } from '../core/tenants';

// Zaxira va tiklash.
//
// Maqsad: guruh ma'lumoti biror sababga ko'ra yo'qolsa (bot guruhdan
// chiqarilgan, tozalash noto'g'ri bosilgan, Volume ulanmay qolgan) —
// super admin oxirgi zaxira faylini botga tashlasa hammasi qaytsin.
//
// Fayl — oddiy JSON. 1 MB dan oshsa gzip qilinadi (Telegram uchun ham
// yengil, ochish ham oson). Tiklashda ikkalasi ham qabul qilinadi.

export const BACKUP_VERSION = 2;

/// Zaxirada TABIIY KALIT ishlatiladi (chatId, telegramId, sana+ovqat turi),
/// cuid emas. Sababi: guruh o'chib qayta qo'shilsa cuid o'zgaradi, lekin
/// chatId o'zgarmaydi — shuning uchun eski zaxira baribir to'g'ri tushadi.
export interface BackupFile {
    version: number;
    botId: string;
    botUsername: string;
    exportedAt: string;
    /// Bot sozlamalari (ovqat vaqtlari, kalit so'zlar) — ular ham tiklanadi
    settings: Record<string, unknown>;
    groups: Array<Record<string, unknown>>;
    members: Array<Record<string, unknown>>;
    /// [guruh chatId, a'zo telegramId, qo'shilgan sana, guruhdagi roli]
    groupMembers: Array<Record<string, unknown>>;
    meals: Array<Record<string, unknown>>;
    reminderOverrides: Array<Record<string, unknown>>;
    businessConnections: Array<Record<string, unknown>>;
}

export interface BackupStats {
    groups: number;
    members: number;
    links: number;
    meals: number;
    overrides: number;
    connections: number;
}

/// Tenant sozlamalarining zaxiraga tushadigan qismi.
/// Token va shifrlangan kalitlar ATAYIN olinmaydi — zaxira fayli oddiy
/// Telegram chatida yotadi, unda maxfiy narsa bo'lmasligi kerak.
const TENANT_SETTING_KEYS = [
    'agentName', 'coachStyle', 'timezone',
    'breakfastTime', 'lunchTime', 'dinnerTime',
    'graceMinutes', 'reminderInterval', 'maxReminders', 'dailyTableHour',
    'requirePhoto', 'autoDeleteReminders',
    'breakfastWords', 'lunchWords', 'dinnerWords',
] as const;

export function backupStats(data: BackupFile): BackupStats {
    return {
        groups: data.groups.length,
        members: data.members.length,
        links: data.groupMembers.length,
        meals: data.meals.length,
        overrides: data.reminderOverrides.length,
        connections: data.businessConnections.length,
    };
}

// ============ EKSPORT ============

export async function exportTenant(tenant: Tenant): Promise<BackupFile> {
    const db = await tenantDb(tenant.botId);

    const [groups, members, links, meals, overrides, connections] = await Promise.all([
        db.group.findMany({ orderBy: { createdAt: 'asc' } }),
        db.member.findMany({ orderBy: { joinedAt: 'asc' } }),
        db.groupMember.findMany({ include: { group: true, member: true } }),
        db.mealRecord.findMany({ include: { group: true, member: true }, orderBy: { timeSent: 'asc' } }),
        db.reminderOverride.findMany({ include: { member: true } }),
        db.businessConnection.findMany(),
    ]);

    const settings: Record<string, unknown> = {};
    for (const key of TENANT_SETTING_KEYS) settings[key] = (tenant as Record<string, any>)[key];

    return {
        version: BACKUP_VERSION,
        botId: tenant.botId,
        botUsername: tenant.botUsername,
        exportedAt: new Date().toISOString(),
        settings,

        groups: groups.map(g => ({
            chatId: g.chatId,
            title: g.title,
            isActive: g.isActive,
            status: g.status,
            approvedAt: g.approvedAt,
            approvedBy: g.approvedBy,
            createdAt: g.createdAt,
        })),

        members: members.map(m => ({
            telegramId: m.telegramId,
            name: m.name,
            username: m.username,
            role: m.role,
            status: m.status,
            timezone: m.timezone,
            latitude: m.latitude,
            longitude: m.longitude,
            dmOpen: m.dmOpen,
            note: m.note,
            joinedAt: m.joinedAt,
        })),

        groupMembers: links.map(l => ({
            chatId: l.group.chatId,
            telegramId: l.member.telegramId,
            role: l.role,
            joinedAt: l.joinedAt,
        })),

        meals: meals.map(r => ({
            telegramId: r.member.telegramId,
            chatId: r.group?.chatId ?? null,
            date: r.date,
            mealType: r.mealType,
            timeSent: r.timeSent,
            status: r.status,
            photoFileId: r.photoFileId,
            messageId: r.messageId,
            caption: r.caption,
        })),

        reminderOverrides: overrides.map(o => ({
            telegramId: o.member.telegramId,
            mealType: o.mealType,
            muted: o.muted,
        })),

        businessConnections: connections.map(c => ({
            connectionId: c.connectionId,
            userTgId: c.userTgId,
            userChatId: c.userChatId,
            userName: c.userName,
            canReply: c.canReply,
            isEnabled: c.isEnabled,
        })),
    };
}

/// Yuborishga tayyor fayl. 1 MB dan katta bo'lsa gzip.
export async function exportTenantFile(tenant: Tenant): Promise<{
    buffer: Buffer;
    filename: string;
    stats: BackupStats;
    data: BackupFile;
}> {
    const data = await exportTenant(tenant);
    const json = Buffer.from(JSON.stringify(data, null, 1), 'utf8');
    const date = data.exportedAt.slice(0, 10);
    const base = `temurfitpro-${tenant.botUsername || tenant.botId}-${date}`;

    if (json.length > 1024 * 1024) {
        return {
            buffer: zlib.gzipSync(json),
            filename: `${base}.json.gz`,
            stats: backupStats(data),
            data,
        };
    }
    return { buffer: json, filename: `${base}.json`, stats: backupStats(data), data };
}

// ============ FAYLNI O'QISH ============

export class BackupError extends Error {}

/// Yuklangan faylni tekshirib BackupFile ga aylantirish.
/// gzip ham, oddiy JSON ham qabul qilinadi.
export function parseBackup(buffer: Buffer): BackupFile {
    let raw = buffer;
    // gzip sehrli baytlari
    if (raw.length > 2 && raw[0] === 0x1f && raw[1] === 0x8b) {
        try {
            raw = zlib.gunzipSync(raw);
        } catch {
            throw new BackupError('Fayl gzip deb ko\'rindi, lekin ochilmadi — buzilgan bo\'lishi mumkin.');
        }
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw.toString('utf8'));
    } catch {
        throw new BackupError('Bu JSON fayl emas. Botdan kelgan zaxira faylini tashlang.');
    }

    const data = parsed as Partial<BackupFile>;
    if (!data || typeof data !== 'object' || !Array.isArray(data.groups) || !Array.isArray(data.members)) {
        throw new BackupError('Fayl tuzilishi mos emas — bu TemurFitPro zaxirasi emas.');
    }
    if (typeof data.version !== 'number' || data.version > BACKUP_VERSION) {
        throw new BackupError(
            `Fayl versiyasi (${String(data.version)}) bu botdan yangiroq. Avval botni yangilang.`,
        );
    }

    // Eski versiyalarda bo'lmagan maydonlar
    return {
        version: data.version,
        botId: String(data.botId ?? ''),
        botUsername: String(data.botUsername ?? ''),
        exportedAt: String(data.exportedAt ?? ''),
        settings: (data.settings as Record<string, unknown>) ?? {},
        groups: data.groups,
        members: data.members,
        groupMembers: data.groupMembers ?? [],
        meals: data.meals ?? [],
        reminderOverrides: data.reminderOverrides ?? [],
        businessConnections: data.businessConnections ?? [],
    };
}

// ============ TIKLASH ============

export type RestoreMode = 'merge' | 'replace';

export interface RestoreResult {
    mode: RestoreMode;
    groups: { created: number; updated: number };
    members: { created: number; updated: number };
    links: number;
    meals: { created: number; skipped: number };
    overrides: number;
    connections: number;
    settingsRestored: boolean;
}

function str(v: unknown): string {
    return typeof v === 'string' ? v : String(v ?? '');
}
function date(v: unknown): Date | undefined {
    if (!v) return undefined;
    const d = new Date(v as string);
    return isNaN(d.getTime()) ? undefined : d;
}

/// Zaxiradan tiklash.
///
/// merge   — hech narsa o'chirilmaydi. Yo'q yozuvlar qo'shiladi, bor
///           yozuvlar yangilanadi. "Guruh datasi ochib ketdi" holati uchun.
/// replace — avval butun tenant ma'lumoti o'chiriladi, keyin fayldan
///           to'liq tiklanadi. Faylda nima bo'lsa — aynan shu qoladi.
export async function importTenant(
    tenant: Tenant,
    data: BackupFile,
    mode: RestoreMode,
    actorTgId: string,
): Promise<RestoreResult> {
    const db = await tenantDb(tenant.botId);

    const res: RestoreResult = {
        mode,
        groups: { created: 0, updated: 0 },
        members: { created: 0, updated: 0 },
        links: 0,
        meals: { created: 0, skipped: 0 },
        overrides: 0,
        connections: 0,
        settingsRestored: false,
    };

    if (mode === 'replace') {
        // Tartib muhim: bog'liq jadvallar avval
        await db.mention.deleteMany({});
        await db.mealRecord.deleteMany({});
        await db.reminderOverride.deleteMany({});
        await db.groupMember.deleteMany({});
        await db.member.deleteMany({});
        await db.group.deleteMany({});
        await db.businessConnection.deleteMany({});
    }

    // ---- Guruhlar (tabiiy kalit: chatId) ----
    const groupIdByChat = new Map<string, string>();
    for (const g of data.groups) {
        const chatId = str(g.chatId);
        if (!chatId) continue;

        const existing = await db.group.findUnique({ where: { chatId } });
        const payload = {
            title: str(g.title),
            status: str(g.status) || 'approved',
            approvedAt: date(g.approvedAt) ?? null,
            approvedBy: g.approvedBy ? str(g.approvedBy) : null,
        };

        if (existing) {
            // isActive ga TEGMAYMIZ: bot hozir guruh ichidami — buni jonli
            // holat biladi, eski fayl emas. Aks holda tiklash chiqarilgan
            // guruhni "faol" deb ko'rsatib qo'yardi.
            const row = await db.group.update({ where: { chatId }, data: payload });
            groupIdByChat.set(chatId, row.id);
            res.groups.updated++;
        } else {
            const row = await db.group.create({
                data: {
                    chatId,
                    ...payload,
                    isActive: Boolean(g.isActive ?? true),
                    createdAt: date(g.createdAt),
                },
            });
            groupIdByChat.set(chatId, row.id);
            res.groups.created++;
        }
    }

    // ---- A'zolar (tabiiy kalit: telegramId) ----
    const memberIdByTg = new Map<string, string>();
    for (const m of data.members) {
        const telegramId = str(m.telegramId);
        if (!telegramId) continue;

        const name = str(m.name) || telegramId;
        const payload = {
            name,
            nameLc: name.toLowerCase(),
            username: m.username ? str(m.username) : null,
            role: str(m.role) || 'member',
            status: str(m.status) || 'active',
            timezone: str(m.timezone) || 'Asia/Tashkent',
            latitude: typeof m.latitude === 'number' ? m.latitude : null,
            longitude: typeof m.longitude === 'number' ? m.longitude : null,
            dmOpen: Boolean(m.dmOpen),
            note: str(m.note),
        };

        const existing = await db.member.findUnique({ where: { telegramId } });
        if (existing) {
            const row = await db.member.update({ where: { telegramId }, data: payload });
            memberIdByTg.set(telegramId, row.id);
            res.members.updated++;
        } else {
            const row = await db.member.create({
                data: { telegramId, ...payload, joinedAt: date(m.joinedAt) },
            });
            memberIdByTg.set(telegramId, row.id);
            res.members.created++;
        }
    }

    // ---- Kim qaysi guruhda ----
    for (const l of data.groupMembers) {
        const groupId = groupIdByChat.get(str(l.chatId));
        const memberId = memberIdByTg.get(str(l.telegramId));
        if (!groupId || !memberId) continue;

        await db.groupMember.upsert({
            where: { groupId_memberId: { groupId, memberId } },
            create: { groupId, memberId, role: str(l.role) || 'member', joinedAt: date(l.joinedAt) },
            update: { role: str(l.role) || 'member' },
        });
        res.links++;
    }

    // ---- Ovqat qaydlari (tabiiy kalit: a'zo + sana + ovqat turi) ----
    for (const r of data.meals) {
        const memberId = memberIdByTg.get(str(r.telegramId));
        if (!memberId) continue;
        const date_ = str(r.date);
        const mealType = str(r.mealType);
        if (!date_ || !mealType) continue;

        const groupId = r.chatId ? (groupIdByChat.get(str(r.chatId)) ?? null) : null;
        const payload = {
            groupId,
            timeSent: date(r.timeSent) ?? new Date(),
            status: str(r.status) || 'on_time',
            photoFileId: r.photoFileId ? str(r.photoFileId) : null,
            messageId: typeof r.messageId === 'number' ? r.messageId : null,
            caption: r.caption ? str(r.caption) : null,
        };

        const existing = await db.mealRecord.findUnique({
            where: { memberId_date_mealType: { memberId, date: date_, mealType } },
        });

        if (existing) {
            // Mavjud qaydga TEGMAYMIZ — jonli ma'lumot fayldan yangiroq
            // bo'lishi mumkin (bugun yuborilgan ovqat kechagi zaxirada yo'q).
            res.meals.skipped++;
            continue;
        }

        await db.mealRecord.create({ data: { memberId, date: date_, mealType, ...payload } });
        res.meals.created++;
    }

    // ---- Eslatma sozlamalari ----
    for (const o of data.reminderOverrides) {
        const memberId = memberIdByTg.get(str(o.telegramId));
        const mealType = str(o.mealType);
        if (!memberId || !mealType) continue;

        await db.reminderOverride.upsert({
            where: { memberId_mealType: { memberId, mealType } },
            create: { memberId, mealType, muted: Boolean(o.muted) },
            update: { muted: Boolean(o.muted) },
        });
        res.overrides++;
    }

    // ---- Telegram Business ulanishlari ----
    for (const c of data.businessConnections) {
        const connectionId = str(c.connectionId);
        if (!connectionId) continue;
        const payload = {
            userTgId: str(c.userTgId),
            userChatId: str(c.userChatId),
            userName: str(c.userName),
            canReply: Boolean(c.canReply),
            isEnabled: Boolean(c.isEnabled),
        };
        await db.businessConnection.upsert({
            where: { connectionId },
            create: { connectionId, ...payload },
            update: payload,
        });
        res.connections++;
    }

    // ---- Bot sozlamalari ----
    const settingsPatch: Record<string, unknown> = {};
    for (const key of TENANT_SETTING_KEYS) {
        const v = data.settings?.[key];
        if (v !== undefined && v !== null) settingsPatch[key] = v;
    }
    if (Object.keys(settingsPatch).length) {
        await prisma.tenant.update({ where: { id: tenant.id }, data: settingsPatch as any });
        res.settingsRestored = true;
    }

    if (mode === 'replace') await vacuumTenantDb(tenant.botId);

    await audit(
        tenant.id,
        actorTgId,
        `data.restore.${mode}`,
        `${res.groups.created + res.groups.updated} guruh, ${res.members.created + res.members.updated} a'zo, ${res.meals.created} yangi ovqat qaydi`,
    );
    log.info('backup', `tiklandi (${mode}, bot=${tenant.botId}): ${JSON.stringify(res)}`);

    return res;
}

// ============ KUNLIK YUBORISH ============

/// Bitta botning zaxirasini barcha super adminlarga yuborish.
/// controlBot dinamik import qilinadi — modullar aylanma bog'lanmasin.
export async function sendBackupToAdmins(tenant: Tenant): Promise<number> {
    const { controlBot } = await import('../bots/control');
    const admins = await prisma.superAdmin.findMany();
    if (!admins.length) return 0;

    const { buffer, filename, stats } = await exportTenantFile(tenant);
    const caption = [
        `💾 <b>Kunlik zaxira</b> — @${tenant.botUsername}`,
        `🏠 ${stats.groups} guruh · 👥 ${stats.members} a'zo · 🍽 ${stats.meals} qayd`,
        '',
        "<i>Ma'lumot yo'qolsa shu faylni botga qaytarib tashlang:</i>",
        '<i>🤖 Botlar → bot → 💾 Zaxira → ♻️ Fayldan tiklash</i>',
    ].join('\n');

    let sent = 0;
    for (const admin of admins) {
        try {
            await controlBot.telegram.sendDocument(
                admin.telegramId,
                { source: buffer, filename },
                { caption, parse_mode: 'HTML' },
            );
            sent++;
        } catch (e) {
            // Admin botni bloklagan yoki hali /start bosmagan bo'lishi mumkin
            log.warn('backup', `zaxira yuborilmadi (${admin.telegramId}): ${String(e).slice(0, 160)}`);
        }
    }
    return sent;
}

export function formatRestore(res: RestoreResult): string {
    return [
        `♻️ <b>Tiklandi</b> — ${res.mode === 'replace' ? "to'liq almashtirish" : "qo'shib tiklash"}`,
        '',
        `🏠 Guruhlar: ${res.groups.created} yangi, ${res.groups.updated} yangilandi`,
        `👥 A'zolar: ${res.members.created} yangi, ${res.members.updated} yangilandi`,
        `🔗 Guruh a'zoligi: ${res.links}`,
        `🍽 Ovqat qaydi: ${res.meals.created} tiklandi, ${res.meals.skipped} allaqachon bor edi`,
        ...(res.overrides ? [`🔔 Eslatma sozlamalari: ${res.overrides}`] : []),
        ...(res.connections ? [`💼 Business ulanish: ${res.connections}`] : []),
        ...(res.settingsRestored ? ['⚙️ Bot sozlamalari ham tiklandi'] : []),
    ].join('\n');
}
