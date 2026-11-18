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
import { LIVE_GROUP } from './core/groups';
import { reconcileTenantWebhooks } from './core/registry';
import { sendBackupToAdmins } from './features/backup';
import { runAllMilestones } from './features/milestone';
import { settings } from './core/settings';

let ticking = false;

export function startScheduler(): void {
    // ===== Har daqiqada: chiquvchi xabarlar navbati =====
    // Bu yengil: navbat bo'sh bo'lsa bitta so'rov bilan tugaydi.
    cron.schedule('* * * * *', async () => {
        try {
            const res = await processOutbox();
            if (res.sent || res.failed) log.info('scheduler', `outbox: ${res.sent} yuborildi, ${res.failed} xato`);
        } catch (e) {
            log.error('scheduler', 'navbat xatosi', e);
        }
    });

    // ===== Har 15 daqiqada: eslatmalar =====
    //
    // Nega daqiqada emas: har bir tsikl tenant bazalariga tegadi va o'lchov
    // shuni ko'rsatdi — har tegish xotirada ~5 MB qoldiradi, qaytib
    // bo'shamaydi. Daqiqada supurish 17 daqiqada 107 MB dan 199 MB ga olib
    // chiqardi. Railway esa xotira uchun pul oladi.
    //
    // Aniqlikdan yo'qotish yo'q: eslatmalar orasi 60 daqiqa, kechikish
    // chegarasi ham 60 daqiqa — 15 daqiqalik qadam hech kimga sezilmaydi.
    //
    // Klientni bo'sh turganda yopib ko'rildi — foyda bermadi: o'lchov
    // shuni ko'rsatdi, $disconnect() dan va GC dan keyin ham xotira
    // qaytmaydi. Shuning uchun yagona ishlaydigan yo'l — kamroq tegish.
    cron.schedule('*/15 * * * *', async () => {
        if (ticking) {
            log.warn('scheduler', "oldingi tsikl tugamagan, o'tkazib yuborildi");
            return;
        }
        ticking = true;
        try {
            await runReminders();
        } catch (e) {
            log.error('scheduler', 'eslatma tsikli xatosi', e);
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

    // ===== Har soat: bosqich tabriklari ("10 kun tugadi!") =====
    // Soat boshida emas, 2-daqiqada — kunlik jadval bilan ustma-ust tushmasin.
    cron.schedule('2 * * * *', async () => {
        try {
            const n = await runAllMilestones();
            if (n) log.info('scheduler', `${n} ta bosqich tabrigi yuborildi`);
        } catch (e) {
            log.error('scheduler', 'bosqich tabrigi xatosi', e);
        }
    });

    // ===== Har soat: kunlik zaxirani super adminlarga yuborish =====
    // Ma'lumot yo'qolsa (bot guruhdan chiqarilsa, tozalash noto'g'ri bosilsa,
    // Volume ulanmay qolsa) — super admin oxirgi faylni botga qaytarib tashlaydi.
    cron.schedule('5 * * * *', async () => {
        try {
            await runDailyBackups();
        } catch (e) {
            log.error('scheduler', 'zaxira xatosi', e);
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

// ============ KUNLIK ZAXIRA ============

/// Oxirgi zaxira qaysi kunda yuborilgani (jarayon xotirasida).
/// Railway restart qilsa ko'pi bilan bitta ortiqcha fayl ketadi — zarari yo'q.
const lastBackupDate = new Map<string, string>();

async function runDailyBackups(): Promise<void> {
    const cfg = settings();
    if (!cfg.backupEnabled) return;

    const now = new Date();
    if (now.getUTCHours() !== cfg.backupHour) return;

    const today = now.toISOString().slice(0, 10);
    const tenants = await prisma.tenant.findMany({ where: { status: 'active' } });

    for (const tenant of tenants) {
        if (lastBackupDate.get(tenant.botId) === today) continue;
        try {
            const sent = await sendBackupToAdmins(tenant);
            lastBackupDate.set(tenant.botId, today);
            log.info('scheduler', `zaxira yuborildi: @${tenant.botUsername} → ${sent} admin`);
        } catch (e) {
            log.error('scheduler', `zaxira tayyorlanmadi (${tenant.botId})`, e);
        }
    }
}

// ============ ESLATMALAR ============

async function runReminders(): Promise<void> {
    const tenants = await prisma.tenant.findMany({ where: { status: 'active' } });

    for (const tenant of tenants) {
        if (!getBotByTenant(tenant.id) || tenant.maxReminders === 0) continue;

        const db = await tenantDb(tenant.botId);
        const groups = await db.group.findMany({ where: LIVE_GROUP });

        for (const group of groups) {
            await remindGroup(db, tenant, group).catch(e =>
                log.warn('scheduler', `eslatma xatosi (${group.title || group.chatId}): ${tgError(e)}`),
            );
        }
    }
}

/// Kim qaysi ovqat uchun eslatma oynasida turibdi.
///
/// Sof funksiya: bazaga tegmaydi, shuning uchun sinab ko'rsa bo'ladi.
/// Har bir a'zo O'Z vaqt mintaqasida va O'Z ovqat vaqtlarida hisoblanadi.
///
/// Oyna: ovqat vaqti + kechikish chegarasidan keyin boshlanadi,
/// keyingi ovqat vaqtida (kechki uchun kun oxirida) yopiladi.
export function dueReminders(
    tenant: Tenant,
    members: Member[],
    now: Date = new Date(),
): Array<{ member: Member; meal: MealType; date: string }> {
    const due: Array<{ member: Member; meal: MealType; date: string }> = [];

    for (const member of members) {
        const tz = safeTz(member.timezone);
        const nowMin = localMinutes(tz, now);
        const date = todayIn(tz, now);

        for (const meal of MEAL_TYPES) {
            const target = mealTargetMinutes(tenant, meal, member);
            const windowEnd = mealWindowEnd(tenant, meal, member);
            if (nowMin <= target + tenant.graceMinutes || nowMin > windowEnd) continue;
            due.push({ member, meal, date });
        }
    }
    return due;
}

/// Bitta guruhning eslatmalari.
///
/// DIQQAT: bu funksiya har DAQIQADA, kuniga 1440 marta ishlaydi. Ilgari u
/// har bir a'zo uchun alohida uchta so'rov yuborardi — 60 a'zoda daqiqasiga
/// 540 tagacha Prisma so'rovi. O'lchov shuni ko'rsatdi: shu tsikl yoqiq
/// bo'lsa xotira daqiqasiga ~5 MB o'sib borardi (17 daqiqada 107 MB dan
/// 199 MB ga), o'chirilsa esa 110 MB da turib qolardi.
///
/// Shuning uchun endi:
///   1) kim eslatma oynasida ekani BAZAGA TEGMASDAN hisoblanadi
///   2) hech kim bo'lmasa — bitta ham so'rov yuborilmaydi (ko'p daqiqalarda shunday)
///   3) bor bo'lsa — a'zo boshiga emas, GURUH boshiga uchta to'plam so'rov
async function remindGroup(db: TenantClient, tenant: Tenant, group: Group): Promise<void> {
    const links = await db.groupMember.findMany({
        where: { groupId: group.id, member: { status: 'active', role: 'member' } },
        include: { member: true },
    });
    if (links.length === 0) return;

    // 1) Oynada turganlarni xotirada aniqlaymiz
    const due = dueReminders(tenant, links.map(l => l.member));
    if (due.length === 0) return; // eng ko'p uchraydigan holat — bazaga umuman tegmaymiz

    const memberIds = [...new Set(due.map(d => d.member.id))];
    const dates = [...new Set(due.map(d => d.date))];

    // 2) Uchta to'plam so'rov — a'zo soniga bog'liq emas
    const [overrides, records, mentions] = await Promise.all([
        db.reminderOverride.findMany({
            where: { memberId: { in: memberIds }, muted: true },
            select: { memberId: true, mealType: true },
        }),
        db.mealRecord.findMany({
            where: { memberId: { in: memberIds }, date: { in: dates } },
            select: { memberId: true, mealType: true, date: true },
        }),
        db.mention.findMany({
            where: { groupId: group.id, memberId: { in: memberIds }, date: { in: dates } },
        }),
    ]);

    // 3) Qolgan tekshiruvlar xotirada
    const slot = (memberId: string, meal: string, date: string) => `${memberId}|${meal}|${date}`;
    const muted = new Set(overrides.map(o => `${o.memberId}|${o.mealType}`));
    const done = new Set(records.map(r => slot(r.memberId, r.mealType, r.date)));
    const sent = new Map(mentions.map(m => [slot(m.memberId, m.mealType, m.date), m]));

    for (const { member, meal, date } of due) {
        if (muted.has(`${member.id}|${meal}`)) continue;
        if (done.has(slot(member.id, meal, date))) continue;

        const existing = sent.get(slot(member.id, meal, date));
        if (existing) {
            if (existing.count >= tenant.maxReminders) continue;
            if (differenceInMinutes(new Date(), existing.updatedAt) < tenant.reminderInterval) continue;
        }

        await sendReminder(db, tenant, group, member, meal, date, existing?.messageId ?? null, existing?.count ?? 0).catch(
            e => log.warn('scheduler', `eslatma yuborilmadi (${member.name}): ${tgError(e)}`),
        );
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
        const groups = await db.group.findMany({ where: LIVE_GROUP });

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
        for (const g of await db.group.findMany({ where: LIVE_GROUP })) {
            await updateGroupTable(db, t, g).catch(() => undefined);
            n++;
        }
    }
    return n;
}
