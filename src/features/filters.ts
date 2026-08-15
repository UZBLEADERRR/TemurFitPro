import type { Tenant } from '@prisma/client';
import { prisma } from '../core/db';
import { MEAL_TYPES, MEAL_LABELS, MealType } from '../core/meals';
import { todayIn, lastNDates, daysAgoIn, safeTz, formatIn } from '../core/time';
import { esc } from '../core/telegram';

export interface MemberBrief {
    id: string;
    telegramId: string;
    name: string;
    username: string | null;
    role: string;
    status: string;
    timezone: string;
    groups: string[];
}

export interface InactiveRow extends MemberBrief {
    /// Oxirgi marta ovqat yuborgan sana (yo'q bo'lsa null)
    lastMealDate: string | null;
    daysSince: number | null;
    missedCount: number;
    missedDetail: string[];
}

export interface StatsRow extends MemberBrief {
    expected: number;
    done: number;
    late: number;
    missed: number;
    rate: number;
}

async function groupFilter(tenantId: string, groupId?: string | null) {
    if (!groupId) return {};
    return { groups: { some: { groupId } } };
}

export async function listGroups(tenantId: string) {
    return prisma.group.findMany({
        where: { tenantId, isActive: true },
        orderBy: { createdAt: 'asc' },
    });
}

export async function listMembers(
    tenantId: string,
    opts: { groupId?: string | null; role?: string; status?: string } = {},
): Promise<MemberBrief[]> {
    const members = await prisma.member.findMany({
        where: {
            tenantId,
            ...(opts.role ? { role: opts.role } : {}),
            status: opts.status ?? 'active',
            ...(await groupFilter(tenantId, opts.groupId)),
        },
        include: { groups: { include: { group: true } } },
        orderBy: { joinedAt: 'asc' },
    });

    return members.map(m => ({
        id: m.id,
        telegramId: m.telegramId,
        name: m.name,
        username: m.username,
        role: m.role,
        status: m.status,
        timezone: m.timezone,
        groups: m.groups.map(g => g.group.title || g.group.chatId),
    }));
}

/// "Oxirgi N kunda ovqat jo'natmaganlar" — murabbiyning asosiy so'rovi.
/// Barcha guruhlar bo'ylab ishlaydi (groupId berilmasa).
export async function findInactive(
    tenant: Tenant,
    opts: { days: number; mealType?: MealType | 'any'; groupId?: string | null; minMissed?: number } = { days: 2 },
): Promise<InactiveRow[]> {
    const days = Math.max(1, Math.min(60, opts.days || 2));
    const meal = opts.mealType && opts.mealType !== 'any' ? opts.mealType : null;

    const members = await prisma.member.findMany({
        where: {
            tenantId: tenant.id,
            status: 'active',
            role: 'member',
            ...(await groupFilter(tenant.id, opts.groupId)),
        },
        include: { groups: { include: { group: true } } },
    });

    const rows: InactiveRow[] = [];

    for (const m of members) {
        const tz = safeTz(m.timezone);

        // Bugun allaqachon ovqat yuborgan bo'lsa — u "yo'qolgan" emas, ogohlantirmaymiz.
        // Aks holda ertalab nonushta yuborgan odam ham ro'yxatga tushib qolardi.
        const activeToday = await prisma.mealRecord.count({
            where: { memberId: m.id, date: todayIn(tz), ...(meal ? { mealType: meal } : {}) },
        });
        if (activeToday > 0) continue;

        // Bugungi kun hali tugamagan — to'liq o'tgan kunlarni tekshiramiz
        const window = lastNDates(tz, days + 1).slice(0, days);
        const mealsInWindow = await prisma.mealRecord.findMany({
            where: {
                memberId: m.id,
                date: { in: window },
                ...(meal ? { mealType: meal } : {}),
            },
            select: { date: true, mealType: true },
        });

        const expectedPerDay = meal ? 1 : MEAL_TYPES.length;
        const missedDetail: string[] = [];
        for (const date of window) {
            const forDate = mealsInWindow.filter(r => r.date === date);
            if (forDate.length < expectedPerDay) {
                const missing = (meal ? [meal] : [...MEAL_TYPES]).filter(
                    t => !forDate.some(r => r.mealType === t),
                );
                missedDetail.push(`${date}: ${missing.map(t => MEAL_LABELS[t]).join(', ')}`);
            }
        }

        const missedCount = missedDetail.length;
        if (missedCount < (opts.minMissed ?? days)) continue; // hammasini o'tkazib yuborgan bo'lishi kerak

        const last = await prisma.mealRecord.findFirst({
            where: { memberId: m.id, ...(meal ? { mealType: meal } : {}) },
            orderBy: { date: 'desc' },
            select: { date: true },
        });

        const daysSince = last
            ? Math.round(
                  (Date.parse(`${todayIn(tz)}T00:00:00Z`) - Date.parse(`${last.date}T00:00:00Z`)) / 86400000,
              )
            : null;

        rows.push({
            id: m.id,
            telegramId: m.telegramId,
            name: m.name,
            username: m.username,
            role: m.role,
            status: m.status,
            timezone: m.timezone,
            groups: m.groups.map(g => g.group.title || g.group.chatId),
            lastMealDate: last?.date ?? null,
            daysSince,
            missedCount,
            missedDetail,
        });
    }

    rows.sort((a, b) => (b.daysSince ?? 999) - (a.daysSince ?? 999));
    return rows;
}

/// Bugun ma'lum ovqatni hali yubormaganlar
export async function findMissingToday(
    tenant: Tenant,
    opts: { mealType?: MealType | 'any'; groupId?: string | null } = {},
): Promise<MemberBrief[]> {
    const members = await prisma.member.findMany({
        where: {
            tenantId: tenant.id,
            status: 'active',
            role: 'member',
            ...(await groupFilter(tenant.id, opts.groupId)),
        },
        include: { groups: { include: { group: true } } },
    });

    const out: MemberBrief[] = [];
    for (const m of members) {
        const date = todayIn(safeTz(m.timezone));
        const records = await prisma.mealRecord.findMany({
            where: { memberId: m.id, date },
            select: { mealType: true },
        });
        const needed = opts.mealType && opts.mealType !== 'any' ? [opts.mealType] : [...MEAL_TYPES];
        const missing = needed.filter(t => !records.some(r => r.mealType === t));
        if (missing.length === 0) continue;
        out.push({
            id: m.id,
            telegramId: m.telegramId,
            name: m.name,
            username: m.username,
            role: m.role,
            status: m.status,
            timezone: m.timezone,
            groups: m.groups.map(g => g.group.title || g.group.chatId),
        });
    }
    return out;
}

/// Davr bo'yicha statistika (intizom foizi)
export async function getStats(
    tenant: Tenant,
    opts: { days?: number; groupId?: string | null } = {},
): Promise<{ rows: StatsRow[]; days: number; from: string; to: string }> {
    const days = Math.max(1, Math.min(90, opts.days ?? 7));
    const members = await prisma.member.findMany({
        where: {
            tenantId: tenant.id,
            status: 'active',
            role: 'member',
            ...(await groupFilter(tenant.id, opts.groupId)),
        },
        include: { groups: { include: { group: true } } },
    });

    const rows: StatsRow[] = [];
    for (const m of members) {
        const tz = safeTz(m.timezone);
        const window = lastNDates(tz, days);
        const records = await prisma.mealRecord.findMany({
            where: { memberId: m.id, date: { in: window } },
            select: { status: true },
        });
        const expected = days * MEAL_TYPES.length;
        const done = records.length;
        const late = records.filter(r => r.status === 'late').length;
        rows.push({
            id: m.id,
            telegramId: m.telegramId,
            name: m.name,
            username: m.username,
            role: m.role,
            status: m.status,
            timezone: m.timezone,
            groups: m.groups.map(g => g.group.title || g.group.chatId),
            expected,
            done,
            late,
            missed: expected - done,
            rate: expected ? Math.round((done / expected) * 100) : 0,
        });
    }

    rows.sort((a, b) => b.rate - a.rate);
    const tz = safeTz(tenant.timezone);
    return { rows, days, from: daysAgoIn(tz, days - 1), to: todayIn(tz) };
}

/// Bitta a'zoning batafsil hisoboti
export async function memberReport(tenant: Tenant, memberId: string, days = 7) {
    const member = await prisma.member.findFirst({
        where: { id: memberId, tenantId: tenant.id },
        include: { groups: { include: { group: true } } },
    });
    if (!member) return null;

    const tz = safeTz(member.timezone);
    const window = lastNDates(tz, days);
    const records = await prisma.mealRecord.findMany({
        where: { memberId: member.id, date: { in: window } },
        orderBy: [{ date: 'asc' }],
    });

    const byDate = window.map(date => ({
        date,
        meals: MEAL_TYPES.map(t => {
            const r = records.find(x => x.date === date && x.mealType === t);
            return { meal: t, status: r ? r.status : 'missing', at: r ? formatIn(r.timeSent, tz, 'HH:mm') : null };
        }),
    }));

    return { member, days, byDate, total: records.length, expected: days * MEAL_TYPES.length };
}

/// A'zoni ism/username/id bo'yicha izlash — AI "Aliga xabar yubor" deganda kerak
export async function searchMembers(tenantId: string, query: string): Promise<MemberBrief[]> {
    const q = query.trim();
    if (!q) return [];
    const members = await prisma.member.findMany({
        where: {
            tenantId,
            OR: [
                { name: { contains: q, mode: 'insensitive' } },
                { username: { contains: q, mode: 'insensitive' } },
                { telegramId: q },
            ],
        },
        include: { groups: { include: { group: true } } },
        take: 25,
    });
    return members.map(m => ({
        id: m.id,
        telegramId: m.telegramId,
        name: m.name,
        username: m.username,
        role: m.role,
        status: m.status,
        timezone: m.timezone,
        groups: m.groups.map(g => g.group.title || g.group.chatId),
    }));
}

// ============ MATNGA AYLANTIRISH (bot javoblari uchun) ============

export function formatInactive(rows: InactiveRow[], days: number): string {
    if (rows.length === 0) return `✅ Oxirgi ${days} kunda hamma o'z ratsionini yuborgan. Ajoyib!`;
    const lines = rows.map((r, i) => {
        const since = r.daysSince === null ? 'hech qachon' : `${r.daysSince} kun oldin`;
        const grp = r.groups.length ? ` · ${esc(r.groups.join(', '))}` : '';
        return `${i + 1}. <b>${esc(r.name)}</b> — oxirgi: ${since}${grp}`;
    });
    return [`⚠️ <b>Oxirgi ${days} kunda yubormaganlar (${rows.length})</b>`, '', ...lines].join('\n');
}

export function formatStats(res: { rows: StatsRow[]; days: number; from: string; to: string }): string {
    if (res.rows.length === 0) return "A'zolar topilmadi.";
    const lines = res.rows.map((r, i) => {
        const bar = '█'.repeat(Math.round(r.rate / 10)).padEnd(10, '░');
        return `${String(i + 1).padStart(2)}. <code>${bar}</code> ${r.rate}% — ${esc(r.name)}`;
    });
    const avg = Math.round(res.rows.reduce((s, r) => s + r.rate, 0) / res.rows.length);
    return [
        `📊 <b>Intizom reytingi — ${res.days} kun</b>`,
        `<i>${res.from} … ${res.to}</i>`,
        '',
        ...lines,
        '',
        `O'rtacha: <b>${avg}%</b>`,
    ].join('\n');
}

export function formatMissingToday(rows: MemberBrief[], mealLabel: string): string {
    if (rows.length === 0) return `✅ Bugun ${mealLabel} bo'yicha hamma yuborgan.`;
    const lines = rows.map((r, i) => `${i + 1}. ${esc(r.name)}`);
    return [`⏳ <b>Bugun ${mealLabel} yubormaganlar (${rows.length})</b>`, '', ...lines].join('\n');
}
