import cron from 'node-cron';
import { differenceInMinutes } from 'date-fns';
import type { Tenant } from './generated/platform';
import type { Group, Member } from './generated/tenant';
import type { TenantClient } from './core/db';
import { prisma, tenantDb } from './core/db';
import { getBotByTenant } from './core/registry';
import { log } from './core/logger';
import { mention, withRetry, tgError } from './core/telegram';
import { MEAL_TYPES, MEAL_LABELS, MealType, mealTargetMinutes, mealWindowEnd } from './core/meals';
import { todayIn, localMinutes, safeTz } from './core/time';
import { updateGroupTable, createAndPinTable } from './features/table';
import { processOutbox } from './features/outbox';
import { reconcileTenantWebhooks } from './core/registry';

let ticking = false;

export function startScheduler(): void {
    // ===== Har daqiqada: eslatmalar + chiquvchi navbat =====
    cron.schedule('* * * * *', async () => {
        if (ticking) {
            log.warn('scheduler', "oldingi tsikl tugamagan, o'tkazib yuborildi");
            return;
        }
        ticking = true;
        try {
            await runReminders();
            const res = await processOutbox();
            if (res.sent || res.failed) log.info('scheduler', `outbox: ${res.sent} yuborildi, ${res.failed} xato`);
        } catch (e) {
            log.error('scheduler', 'daqiqalik tsikl xatosi', e);
        } finally {
            ticking = false;
        }
    });

    // ===== Har soat boshida: kunlik jadval =====
    cron.schedule('0 * * * *', async () => {
        try {
            await runDailyTables();
        } catch (e) {
            log.error('scheduler', 'kunlik jadval xatosi', e);
        }
    });

    // ===== Har 10 daqiqada: webhooklarni tekshirish =====
    // Telegram bir marta javob bermay qolsa (504), bot butunlay kar bo'lib
    // qolmasin — holatni tekshirib, mos kelmasa qayta o'rnatamiz.
    cron.schedule('*/10 * * * *', async () => {
        try {
            // Ona bot: aylanma importni oldini olish uchun kechiktirilgan yuklash
            const { reconcileControlWebhook } = await import('./index');
            await reconcileControlWebhook();
            const res = await reconcileTenantWebhooks();
            if (res.fixed > 0) log.info('scheduler', `webhook tiklandi: ${res.fixed}/${res.checked}`);
        } catch (e) {
            log.error('scheduler', 'webhook tekshiruvi xatosi', e);
        }
    });

    // ===== Har kuni 03:00 UTC: eski yozuvlarni tozalash =====
    cron.schedule('0 3 * * *', async () => {
        try {
            const cutoff = new Date(Date.now() - 30 * 24 * 3600_000);
            let removed = 0;
            const tenants = await prisma.tenant.findMany();
            for (const t of tenants) {
                const db = await tenantDb(t.botId);
                removed += (
                    await db.outboundMessage.deleteMany({
                        where: { status: { in: ['sent', 'cancelled'] }, sentAt: { lt: cutoff } },
                    })
                ).count;
            }
            const logs = await prisma.auditLog.deleteMany({ where: { createdAt: { lt: cutoff } } });
            log.info('scheduler', `tozalandi: ${removed} xabar, ${logs.count} audit yozuv`);
        } catch (e) {
            log.error('scheduler', 'tozalash xatosi', e);
        }
    });

    log.info('scheduler', 'ishga tushdi');
}

// ============ ESLATMALAR ============

async function runReminders(): Promise<void> {
    const tenants = await prisma.tenant.findMany({ where: { status: 'active' } });

    for (const tenant of tenants) {
        if (!getBotByTenant(tenant.id) || tenant.maxReminders === 0) continue;

        const db = await tenantDb(tenant.botId);
        const groups = await db.group.findMany({ where: { isActive: true } });

        for (const group of groups) {
            const links = await db.groupMember.findMany({
                where: { groupId: group.id, member: { status: 'active', role: 'member' } },
                include: { member: true },
            });

            for (const link of links) {
                await remindMember(db, tenant, group, link.member).catch(e =>
                    log.warn('scheduler', `eslatma xatosi (${link.member.name}): ${tgError(e)}`),
                );
            }
        }
    }
}

async function remindMember(db: TenantClient, tenant: Tenant, group: Group, member: Member): Promise<void> {
    const tz = safeTz(member.timezone);
    const nowMin = localMinutes(tz);
    const date = todayIn(tz);

    for (const meal of MEAL_TYPES) {
        const target = mealTargetMinutes(tenant, meal);
        const windowEnd = mealWindowEnd(tenant, meal);

        // Eslatma oynasi: ovqat vaqti + grace dan keyingi ovqat vaqtigacha
        if (nowMin <= target + tenant.graceMinutes || nowMin > windowEnd) continue;

        const muted = await db.reminderOverride.findUnique({
            where: { memberId_mealType: { memberId: member.id, mealType: meal } },
        });
        if (muted?.muted) continue;

        const already = await db.mealRecord.findUnique({
            where: { memberId_date_mealType: { memberId: member.id, date, mealType: meal } },
        });
        if (already) continue;

        const existing = await db.mention.findUnique({
            where: {
                groupId_memberId_mealType_date: { groupId: group.id, memberId: member.id, mealType: meal, date },
            },
        });

        if (existing) {
            if (existing.count >= tenant.maxReminders) continue;
            if (differenceInMinutes(new Date(), existing.updatedAt) < tenant.reminderInterval) continue;
        }

        await sendReminder(db, tenant, group, member, meal, date, existing?.messageId ?? null, existing?.count ?? 0);
    }
}

async function sendReminder(
    db: TenantClient,
    tenant: Tenant,
    group: Group,
    member: Member,
    meal: MealType,
    date: string,
    oldMessageId: number | null,
    count: number,
): Promise<void> {
    const bot = getBotByTenant(tenant.id);
    if (!bot) return;

    // Eski eslatmani o'chirib, yangisini yuboramiz — guruh toza qoladi
    if (oldMessageId && tenant.autoDeleteReminders) {
        await bot.telegram.deleteMessage(group.chatId, oldMessageId).catch(() => undefined);
    }

    const nth = count + 1;
    const urgency = nth >= tenant.maxReminders ? '🚨' : nth > 1 ? '⚠️' : '⏰';
    const text =
        `${urgency} ${mention(member.telegramId, member.name)}, <b>${MEAL_LABELS[meal]}</b> rasmini hali yubormadingiz!` +
        (nth > 1 ? `\n<i>Eslatma ${nth}/${tenant.maxReminders}</i>` : '');

    try {
        const sent = await withRetry(() =>
            bot.telegram.sendMessage(group.chatId, text, {
                parse_mode: 'HTML',
                link_preview_options: { is_disabled: true },
            }),
        );

        await db.mention.upsert({
            where: {
                groupId_memberId_mealType_date: { groupId: group.id, memberId: member.id, mealType: meal, date },
            },
            create: {
                groupId: group.id,
                memberId: member.id,
                mealType: meal,
                date,
                messageId: sent.message_id,
                count: 1,
            },
            update: { messageId: sent.message_id, count: { increment: 1 }, updatedAt: new Date() },
        });
    } catch (e) {
        log.warn('scheduler', `eslatma yuborilmadi (${group.chatId}): ${tgError(e)}`);
    }
}

// ============ KUNLIK JADVAL ============

async function runDailyTables(): Promise<void> {
    const tenants = await prisma.tenant.findMany({ where: { status: 'active' } });

    for (const tenant of tenants) {
        const tz = safeTz(tenant.timezone);
        const hour = Number(
            new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false }).format(new Date()),
        );
        if (hour !== tenant.dailyTableHour) continue;

        const today = todayIn(tz);
        const db = await tenantDb(tenant.botId);
        const groups = await db.group.findMany({ where: { isActive: true } });

        for (const group of groups) {
            if (group.lastTableDate === today) continue;

            const bot = getBotByTenant(tenant.id);
            if (bot && group.pinnedMessageId) {
                await bot.telegram.unpinChatMessage(group.chatId, group.pinnedMessageId).catch(() => undefined);
            }
            await createAndPinTable(db, tenant, group);
            log.info('scheduler', `kunlik jadval: ${group.title || group.chatId} (${today})`);
        }
    }
}

/// Barcha guruhlarning jadvalini majburan yangilash
export async function refreshAllTables(): Promise<number> {
    const tenants = await prisma.tenant.findMany({ where: { status: 'active' } });
    let n = 0;
    for (const t of tenants) {
        const db = await tenantDb(t.botId);
        for (const g of await db.group.findMany({ where: { isActive: true } })) {
            await updateGroupTable(db, t, g).catch(() => undefined);
            n++;
        }
    }
    return n;
}
