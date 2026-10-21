import type { Tenant } from '../generated/platform';
import type { TenantClient } from '../core/db';
import { prisma, tenantDb } from '../core/db';
import { getBotByTenant } from '../core/registry';
import { LIVE_GROUP } from '../core/groups';
import { MEAL_TYPES } from '../core/meals';
import { todayIn, localMinutes, safeTz, dateRange } from '../core/time';
import { mention, tgError, safeText, withRetry } from '../core/telegram';
import { log } from '../core/logger';

// Bosqich tabriklari: "10 kun tugadi!", "20 kun tugadi!"...
//
// 40 kunlik challenge'da odamni ushlab turadigan narsa — oraliq natijani
// ko'rish. Har 10 kunda guruhga tabrik tashlanadi: nechanchi kun, shu
// bosqichda nechta ovqat yuborilgani va motivatsion gap.
//
// Guruhga yuboriladi, shaxsiyga emas: ommaviy tabrik qolganlarni ham
// qo'zg'atadi, challenge esa jamoaviy narsa.

/// Bosqichga qarab motivatsion gaplar. Kun qancha ko'p — gap shuncha kuchli.
const LINES: Array<{ upto: number; texts: string[] }> = [
    {
        upto: 10,
        texts: [
            'Eng qiyini — boshlash edi. Siz uni ortda qoldirdingiz.',
            "Birinchi o'n kun odatni quradi. Davom eting.",
            "Organizm endigina moslashyapti. Eng yaxshisi oldinda.",
        ],
    },
    {
        upto: 20,
        texts: [
            "Yarmiga yaqinlashdingiz. Endi bu odat bo'lib boryapti.",
            "Yigirma kun — bu tasodif emas, bu intizom.",
            "Ko'zgu allaqachon farqni ko'rsatyapti. Davom!",
        ],
    },
    {
        upto: 30,
        texts: [
            "O'ttiz kun! Ko'pchilik shu yergacha yetib kelmaydi — siz keldingiz.",
            'Oxirgi bosqich qoldi. Boʻshashmang.',
            'Natija endi aniq koʻrinadi. Finishgacha oz qoldi.',
        ],
    },
    {
        upto: 9999,
        texts: [
            'Siz buni qildingiz. Natija tasodif emas — natija system.',
            "Challenge tugadi, lekin odat qoldi. Eng qimmatlisi shu.",
            "To'liq yo'lni bosib o'tdingiz. Buni hech kim sizdan olmaydi.",
        ],
    },
];

function motivation(day: number, seed: number): string {
    const bucket = LINES.find(b => day <= b.upto) ?? LINES[LINES.length - 1];
    return bucket.texts[seed % bucket.texts.length];
}

/// Qancha kun o'tgani (boshlangan kun = 1-kun).
/// A'zoning O'Z vaqt mintaqasida hisoblanadi.
export function dayNumber(joinedAt: Date, timezone: string, now: Date = new Date()): number {
    const tz = safeTz(timezone);
    const start = todayIn(tz, joinedAt);
    const today = todayIn(tz, now);
    if (today < start) return 0;
    return dateRange(start, today).length;
}

export interface MilestoneMessage {
    day: number;
    text: string;
}

export function buildMessage(
    name: string,
    telegramId: string,
    day: number,
    every: number,
    done: number,
    expected: number,
): string {
    const rate = expected ? Math.round((done / expected) * 100) : 0;
    const bar = '█'.repeat(Math.round(rate / 10)).padEnd(10, '░');

    return safeText(
        [
            `🎉 <b>${day} KUN TUGADI!</b>`,
            '',
            `${mention(telegramId, name)} — tabriklaymiz!`,
            '',
            `Oxirgi ${every} kunda: <b>${done}/${expected}</b> ovqat`,
            `<code>${bar}</code> ${rate}%`,
            '',
            `<i>${motivation(day, day + name.length)}</i>`,
        ].join('\n'),
    );
}

/// Bitta botning barcha guruhlari bo'ylab yetib kelgan bosqichlarni yuborish.
///
/// Scheduler har soat chaqiradi. Tabrik a'zoning mahalliy vaqti bilan
/// belgilangan soatda ketadi, shuning uchun Koreyadagi ham, O'zbekistondagi
/// ham ertalab oladi — yarim tunda emas.
export async function runMilestones(tenant: Tenant): Promise<number> {
    const every = tenant.milestoneEvery;
    if (!every || every < 1) return 0;

    const bot = getBotByTenant(tenant.id);
    if (!bot) return 0;

    const db = await tenantDb(tenant.botId);
    const groups = await db.group.findMany({ where: LIVE_GROUP });

    let sent = 0;

    for (const group of groups) {
        const links = await db.groupMember.findMany({
            where: { groupId: group.id, member: { status: 'active' } },
            include: { member: true },
        });

        for (const link of links) {
            const member = link.member;
            const tz = safeTz(member.timezone);

            // Soat oynasi: mahalliy vaqt bilan belgilangan soat ichida
            const hour = Math.floor(localMinutes(tz) / 60);
            if (hour !== tenant.milestoneHour) continue;

            const day = dayNumber(link.joinedAt, tz);
            if (day < every || day % every !== 0) continue;

            // Shu bosqich allaqachon yuborilganmi
            const already = await db.milestone.findUnique({
                where: { memberId_groupId_day: { memberId: member.id, groupId: group.id, day } },
            });
            if (already) continue;

            // Oxirgi bosqichdagi natija
            const window = dateRange(
                todayIn(tz, new Date(Date.now() - (every - 1) * 86400_000)),
                todayIn(tz),
            );
            const done = await db.mealRecord.count({
                where: { memberId: member.id, date: { in: window } },
            });
            const expected = every * MEAL_TYPES.length;

            const text = buildMessage(member.name, member.telegramId, day, every, done, expected);

            try {
                await withRetry(() =>
                    bot.telegram.sendMessage(group.chatId, text, {
                        parse_mode: 'HTML',
                        link_preview_options: { is_disabled: true },
                    }),
                );
                // Yozuvni YUBORILGANDAN KEYIN qo'yamiz — yuborilmasa
                // keyingi soatda yana urinib ko'radi
                await db.milestone.create({
                    data: { memberId: member.id, groupId: group.id, day },
                });
                sent++;
                log.info('milestone', `${member.name} — ${day} kun (${group.title || group.chatId})`);
            } catch (e) {
                log.warn('milestone', `tabrik yuborilmadi (${member.name}): ${tgError(e)}`);
            }
        }
    }

    return sent;
}

export async function runAllMilestones(): Promise<number> {
    const tenants = await prisma.tenant.findMany({ where: { status: 'active' } });
    let total = 0;
    for (const tenant of tenants) {
        try {
            total += await runMilestones(tenant);
        } catch (e) {
            log.error('milestone', `bosqich xatosi (${tenant.botId})`, e);
        }
    }
    return total;
}
