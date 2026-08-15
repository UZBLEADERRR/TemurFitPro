import { Telegraf } from 'telegraf';
import type { Tenant } from '../generated/platform';
import { prisma, tenantDb, dropTenantDb, vacuumTenantDb } from './db';
import { encrypt, parseBotToken, randomSecret } from './crypto';
import { registerTenant, detachTenant } from './registry';
import { log } from './logger';
import { tgError } from './telegram';

export class TenantError extends Error {}

/// Ona bot orqali yangi mijoz boti qo'shish.
/// Token tekshiriladi (getMe), shifrlanadi, PLATFORMA bazasiga yoziladi,
/// bot uchun ALOHIDA ma'lumot fayli yaratiladi va webhook o'rnatiladi.
export async function createTenant(rawToken: string, createdByTgId: string): Promise<Tenant> {
    const token = rawToken.trim();
    const parsed = parseBotToken(token);
    if (!parsed) throw new TenantError("Token formati noto'g'ri. Namuna: <code>123456789:AAH...</code>");

    const existing = await prisma.tenant.findUnique({ where: { botId: parsed.botId } });
    if (existing) throw new TenantError(`Bu bot allaqachon qo'shilgan: @${existing.botUsername}`);

    let me;
    try {
        const probe = new Telegraf(token);
        me = await probe.telegram.getMe();
    } catch (e) {
        throw new TenantError(`Telegram tokenni qabul qilmadi: ${tgError(e)}`);
    }

    const username = me.username || parsed.botId;
    const tenant = await prisma.tenant.create({
        data: {
            botId: parsed.botId,
            botUsername: username,
            botUsernameLc: username.toLowerCase(),
            botTitle: me.first_name || '',
            botTokenEnc: encrypt(token),
            webhookSecret: randomSecret(),
            createdByTgId,
        },
    });

    // Bot uchun alohida baza faylini yaratamiz
    await tenantDb(tenant.botId);

    await registerTenant(tenant);
    await audit(tenant.id, createdByTgId, 'tenant.create', `@${tenant.botUsername}`);
    log.info('tenants', `yangi tenant: @${tenant.botUsername} (${tenant.botId})`);
    return tenant;
}

export async function pauseTenant(tenantId: string, actorTgId: string): Promise<Tenant> {
    const tenant = await prisma.tenant.update({ where: { id: tenantId }, data: { status: 'paused' } });
    await detachTenant(tenant.botId);
    await audit(tenantId, actorTgId, 'tenant.pause', `@${tenant.botUsername}`);
    return tenant;
}

export async function resumeTenant(tenantId: string, actorTgId: string): Promise<Tenant> {
    const tenant = await prisma.tenant.update({ where: { id: tenantId }, data: { status: 'active' } });
    await registerTenant(tenant);
    await audit(tenantId, actorTgId, 'tenant.resume', `@${tenant.botUsername}`);
    return tenant;
}

/// Botni butunlay o'chirish: webhook uziladi, ma'lumot FAYLI o'chiriladi,
/// platforma bazasidan qatori olib tashlanadi. Hech qanday qoldiq qolmaydi.
export async function deleteTenant(tenantId: string, actorTgId: string): Promise<string> {
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) throw new TenantError('Bot topilmadi');

    await detachTenant(tenant.botId);
    await dropTenantDb(tenant.botId);
    await prisma.tenant.delete({ where: { id: tenantId } });
    await audit(null, actorTgId, 'tenant.delete', `@${tenant.botUsername}`);

    log.info('tenants', `tenant o'chirildi: @${tenant.botUsername} (aktor ${actorTgId})`);
    return tenant.botUsername;
}

// ============ MA'LUMOTLARNI TOZALASH ============

export type PurgeScope = 'meals' | 'members' | 'mentions' | 'outbox' | 'ai' | 'all';

/// Botning tanlangan ma'lumotlarini o'chirish (botning o'zi qoladi).
export async function purgeTenantData(tenant: Tenant, scope: PurgeScope, actorTgId: string): Promise<string> {
    const db = await tenantDb(tenant.botId);
    const parts: string[] = [];

    const wipeMeals = scope === 'meals' || scope === 'all';
    const wipeMembers = scope === 'members' || scope === 'all';
    const wipeMentions = scope === 'mentions' || scope === 'all' || wipeMeals;

    if (wipeMentions) parts.push(`${(await db.mention.deleteMany({})).count} eslatma`);
    if (wipeMeals) parts.push(`${(await db.mealRecord.deleteMany({})).count} ovqat qaydi`);
    if (scope === 'ai' || scope === 'all') parts.push(`${(await db.aiMessage.deleteMany({})).count} AI xabar`);
    if (scope === 'outbox' || scope === 'all') {
        parts.push(`${(await db.outboundMessage.deleteMany({})).count} navbat yozuvi`);
    }
    if (wipeMembers) {
        // Murabbiy va egani saqlaymiz — aks holda bot boshqaruvsiz qoladi
        parts.push(`${(await db.member.deleteMany({ where: { role: 'member' } })).count} a'zo`);
    }

    await vacuumTenantDb(tenant.botId); // bo'shagan joyni diskka qaytaramiz
    await audit(tenant.id, actorTgId, `data.purge.${scope}`, parts.join(', '));
    return parts.length ? parts.join(', ') : "hech narsa o'chirilmadi";
}

/// BITTA GURUHNING ma'lumotlarini tozalash — guruh yopilganda qulay.
/// removeGroup=true bo'lsa guruhning o'zi ham ro'yxatdan chiqadi.
export async function purgeGroupData(
    tenant: Tenant,
    groupId: string,
    actorTgId: string,
    removeGroup = false,
): Promise<string> {
    const db = await tenantDb(tenant.botId);
    const group = await db.group.findUnique({ where: { id: groupId } });
    if (!group) throw new TenantError('Guruh topilmadi');

    const links = await db.groupMember.findMany({ where: { groupId }, select: { memberId: true } });
    const memberIds = links.map(l => l.memberId);

    const mentions = await db.mention.deleteMany({ where: { groupId } });
    const meals = await db.mealRecord.deleteMany({ where: { groupId } });

    // Faqat SHU guruhda bo'lgan a'zolarni o'chiramiz — boshqa guruhda ham
    // turganlar joyida qoladi (ularning tarixi kerak).
    let removedMembers = 0;
    for (const memberId of memberIds) {
        const count = await db.groupMember.count({ where: { memberId } });
        if (count <= 1) {
            const m = await db.member.findUnique({ where: { id: memberId } });
            if (m && m.role === 'member') {
                await db.member.delete({ where: { id: memberId } });
                removedMembers++;
            }
        }
    }
    await db.groupMember.deleteMany({ where: { groupId } });

    if (removeGroup) {
        await db.group.delete({ where: { id: groupId } });
    } else {
        await db.group.update({ where: { id: groupId }, data: { pinnedMessageId: null, lastTableDate: null } });
    }

    await vacuumTenantDb(tenant.botId);

    const summary = `${meals.count} ovqat qaydi, ${mentions.count} eslatma, ${removedMembers} a'zo`;
    await audit(tenant.id, actorTgId, 'data.purge.group', `${group.title || group.chatId}: ${summary}`);
    return summary;
}

/// Belgilangan sanadan eskisini o'chirish — bazani kichik ushlab turish uchun.
export async function purgeOlderThan(tenant: Tenant, beforeDate: string, actorTgId: string): Promise<string> {
    const db = await tenantDb(tenant.botId);
    const meals = await db.mealRecord.deleteMany({ where: { date: { lt: beforeDate } } });
    const mentions = await db.mention.deleteMany({ where: { date: { lt: beforeDate } } });
    await vacuumTenantDb(tenant.botId);
    const summary = `${meals.count} ovqat qaydi, ${mentions.count} eslatma (${beforeDate} dan oldingi)`;
    await audit(tenant.id, actorTgId, 'data.purge.old', summary);
    return summary;
}

// ============ GURUHLAR ============

export async function addGroup(
    tenant: Tenant,
    chatId: string,
    title = '',
): Promise<{ created: boolean; id: string }> {
    const normalized = chatId.trim();
    if (!/^-?\d+$/.test(normalized)) {
        throw new TenantError("Guruh ID faqat raqamlardan iborat bo'lishi kerak (masalan -1001234567890)");
    }

    const db = await tenantDb(tenant.botId);
    const existing = await db.group.findUnique({ where: { chatId: normalized } });
    if (existing) {
        if (!existing.isActive || (title && existing.title !== title)) {
            await db.group.update({
                where: { id: existing.id },
                data: { isActive: true, ...(title ? { title } : {}) },
            });
            return { created: !existing.isActive, id: existing.id };
        }
        return { created: false, id: existing.id };
    }

    const g = await db.group.create({ data: { chatId: normalized, title } });
    return { created: true, id: g.id };
}

// ============ ROLLAR ============

export async function audit(tenantId: string | null, actorTgId: string, action: string, detail = ''): Promise<void> {
    try {
        await prisma.auditLog.create({ data: { tenantId, actorTgId, action, detail } });
    } catch (e) {
        log.warn('audit', `yozib bo'lmadi: ${action}`, e);
    }
}

export async function isSuperAdmin(telegramId: string): Promise<boolean> {
    return !!(await prisma.superAdmin.findUnique({ where: { telegramId } }));
}

export async function findTenantByHint(hint: string): Promise<Tenant | null> {
    const clean = hint.replace(/^@/, '').trim();
    return (
        (await prisma.tenant.findFirst({ where: { botUsernameLc: clean.toLowerCase() } })) ||
        (await prisma.tenant.findUnique({ where: { id: hint } })) ||
        (await prisma.tenant.findUnique({ where: { botId: clean } }).catch(() => null))
    );
}
