import { Telegraf } from 'telegraf';
import type { Tenant } from '@prisma/client';
import { prisma } from './db';
import { encrypt, parseBotToken, randomSecret } from './crypto';
import { registerTenant, detachTenant } from './registry';
import { log } from './logger';
import { tgError } from './telegram';

export class TenantError extends Error {}

/// Ona bot orqali yangi mijoz boti qo'shish.
/// Token tekshiriladi (getMe), shifrlanadi, DB'ga yoziladi va webhook o'rnatiladi.
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

    const tenant = await prisma.tenant.create({
        data: {
            botId: parsed.botId,
            botUsername: me.username || parsed.botId,
            botTitle: me.first_name || '',
            botTokenEnc: encrypt(token),
            webhookSecret: randomSecret(),
            createdByTgId,
        },
    });

    await registerTenant(tenant);
    await audit(tenant.id, createdByTgId, 'tenant.create', `@${tenant.botUsername}`);
    log.info('tenants', `yangi tenant: @${tenant.botUsername} (${tenant.id})`);
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

/// Botni va uning BARCHA ma'lumotlarini o'chirish (cascade).
export async function deleteTenant(tenantId: string, actorTgId: string): Promise<string> {
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) throw new TenantError('Bot topilmadi');
    await detachTenant(tenant.botId);
    await prisma.tenant.delete({ where: { id: tenantId } });
    log.info('tenants', `tenant o'chirildi: @${tenant.botUsername} (aktor ${actorTgId})`);
    return tenant.botUsername;
}

/// Tanlangan ma'lumot turlarini tozalash — botning o'zi qoladi.
export type PurgeScope = 'meals' | 'members' | 'mentions' | 'ai' | 'outbox' | 'all';

export async function purgeTenantData(tenantId: string, scope: PurgeScope, actorTgId: string): Promise<string> {
    const parts: string[] = [];
    const wipeMeals = scope === 'meals' || scope === 'all';
    const wipeMembers = scope === 'members' || scope === 'all';
    const wipeMentions = scope === 'mentions' || scope === 'all' || wipeMeals;

    if (wipeMentions) {
        const r = await prisma.mention.deleteMany({ where: { tenantId } });
        parts.push(`${r.count} eslatma`);
    }
    if (wipeMeals) {
        const r = await prisma.mealRecord.deleteMany({ where: { tenantId } });
        parts.push(`${r.count} ovqat qaydi`);
    }
    if (scope === 'ai' || scope === 'all') {
        const r = await prisma.aiMessage.deleteMany({ where: { tenantId } });
        parts.push(`${r.count} AI xabar`);
    }
    if (scope === 'outbox' || scope === 'all') {
        const r = await prisma.outboundMessage.deleteMany({ where: { tenantId, status: 'pending' } });
        parts.push(`${r.count} navbatdagi xabar`);
    }
    if (wipeMembers) {
        // Murabbiy/egani saqlab qolamiz — aks holda bot boshqaruvsiz qoladi
        const r = await prisma.member.deleteMany({ where: { tenantId, role: 'member' } });
        parts.push(`${r.count} a'zo`);
    }

    await audit(tenantId, actorTgId, `data.purge.${scope}`, parts.join(', '));
    return parts.length ? parts.join(', ') : "hech narsa o'chirilmadi";
}

export async function addGroup(tenantId: string, chatId: string, title = ''): Promise<{ created: boolean; id: string }> {
    const normalized = chatId.trim();
    if (!/^-?\d+$/.test(normalized)) throw new TenantError("Guruh ID faqat raqamlardan iborat bo'lishi kerak (masalan -1001234567890)");

    const existing = await prisma.group.findUnique({
        where: { tenantId_chatId: { tenantId, chatId: normalized } },
    });
    if (existing) {
        if (!existing.isActive) {
            await prisma.group.update({ where: { id: existing.id }, data: { isActive: true } });
            return { created: true, id: existing.id };
        }
        return { created: false, id: existing.id };
    }

    const g = await prisma.group.create({ data: { tenantId, chatId: normalized, title } });
    return { created: true, id: g.id };
}

export async function audit(tenantId: string | null, actorTgId: string, action: string, detail = ''): Promise<void> {
    try {
        await prisma.auditLog.create({ data: { tenantId, actorTgId, action, detail } });
    } catch (e) {
        log.warn('audit', `yozib bo'lmadi: ${action}`, e);
    }
}

export async function isSuperAdmin(telegramId: string): Promise<boolean> {
    const found = await prisma.superAdmin.findUnique({ where: { telegramId } });
    return !!found;
}

/// Tenant ichidagi rol: owner/coach — boshqaruv huquqi bor
export async function isCoach(tenantId: string, telegramId: string): Promise<boolean> {
    const m = await prisma.member.findUnique({
        where: { tenantId_telegramId: { tenantId, telegramId } },
    });
    return m?.role === 'coach' || m?.role === 'owner';
}
