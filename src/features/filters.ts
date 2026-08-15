import type { Tenant } from '../generated/platform';
import type { TenantClient } from '../core/db';
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
    lastMealDate: string | null;
    daysSince: number | null;
    missedCount: number;
}

export interface StatsRow extends MemberBrief {
    expected: number;
    done: number;
    late: number;
    missed: number;
    rate: number;
}

type MemberWithGroups = {
    id: string;
    telegramId: string;
    name: string;
    username: string | null;
    role: string;
    status: string;
    timezone: string;
    groups: { group: { title: string; chatId: string } }[];
};

function brief(m: MemberWithGroups): MemberBrief {
    return {
        id: m.id,
        telegramId: m.telegramId,
        name: m.name,
        username: m.username,
        role: m.role,
        status: m.status,
        timezone: m.timezone,
        groups: m.groups.map(g => g.group.title || g.group.chatId),
    };
}

const withGroups = { groups: { include: { group: true } } } as const;

function groupScope(groupId?: string | null) {
    return groupId ? { groups: { some: { groupId } } } : {};
}

export async function listGroups(db: TenantClient) {
    return db.group.findMany({ where: { isActive: true }, orderBy: { createdAt: 'asc' } });
}

export async function listMembers(
    db: TenantClient,
    opts: { groupId?: string | null; role?: string; status?: string } = {},
): Promise<MemberBrief[]> {
    const members = await db.member.findMany({
        where: {
            ...(opts.role ? { role: opts.role } : {}),
            status: opts.status ?? 'active',
            ...groupScope(opts.groupId),
        },
        include: withGroups,
        orderBy: { joinedAt: 'asc' },
    });
    return members.map(brief);
}

/// "Oxirgi N kunda ovqat jo'natmaganlar" — murabbiyning asosiy so'rovi.
/// groupId berilmasa BARCHA guruhlar bo'ylab ishlaydi.
export async function findInactive(
    db: TenantClient,
    tenant: Tenant,
    opts: { days: number; mealType?: MealType | 'any'; groupId?: string | null } = { days: 2 },
): Promise<InactiveRow[]> {
    const days = Math.max(1, Math.min(60, opts.days || 2));
    const meal = opts.mealType && opts.mealType !== 'any' ? opts.mealType : null;

    const members = await db.member.findMany({
        where: { status: 'active', role: 'member', ...groupScope(opts.groupId) },
        include: withGroups,
    });

    const rows: InactiveRow[] = [];

    for (const m of members) {
        const tz = safeTz(m.timezone);

        // Bugun allaqachon ovqat yuborgan bo'lsa — u "yo'qolgan" emas.
        // Aks holda ertalab nonushta yuborgan odam ham ro'yxatga tushib qolardi.
        const activeToday = await db.mealRecord.count({
            where: { memberId: m.id, date: todayIn(tz), ...(meal ? { mealType: meal } : {}) },
        });
        if (activeToday > 0) continue;

        // Bugungi kun hali tugamagan — to'liq o'tgan kunlarni tekshiramiz
        const window = lastNDates(tz, days + 1).slice(0, days);
        const inWindow = await db.mealRecord.count({
            where: { memberId: m.id, date: { in: window }, ...(meal ? { mealType: meal } : {}) },
        });
        if (inWindow > 0) continue;

        const last = await db.mealRecord.findFirst({
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
            ...brief(m),
            lastMealDate: last?.date ?? null,
            daysSince,
            missedCount: days,
        });
    }

    rows.sort((a, b) => (b.daysSince ?? 9999) - (a.daysSince ?? 9999));
    return rows;
}

/// Bugun ma'lum ovqatni hali yubormaganlar (barcha guruhlar bo'ylab)
export async function findMissingToday(
    db: TenantClient,
    opts: { mealType?: MealType | 'any'; groupId?: string | null } = {},
): Promise<Array<MemberBrief & { missing: MealType[] }>> {
    const members = await db.member.findMany({
        where: { status: 'active', role: 'member', ...groupScope(opts.groupId) },
        include: withGroups,
    });

    const out: Array<MemberBrief & { missing: MealType[] }> = [];
    for (const m of members) {
        const date = todayIn(safeTz(m.timezone));
        const records = await db.mealRecord.findMany({ where: { memberId: m.id, date }, select: { mealType: true } });
        const needed = opts.mealType && opts.mealType !== 'any' ? [opts.mealType] : [...MEAL_TYPES];
        const missing = needed.filter(t => !records.some(r => r.mealType === t));
        if (missing.length === 0) continue;
        out.push({ ...brief(m), missing });
    }
    return out;
}

/// Davr bo'yicha intizom statistikasi
export async function getStats(
    db: TenantClient,
    tenant: Tenant,
    opts: { days?: number; groupId?: string | null } = {},
): Promise<{ rows: StatsRow[]; days: number; from: string; to: string }> {
    const days = Math.max(1, Math.min(90, opts.days ?? 7));
    const members = await db.member.findMany({
        where: { status: 'active', role: 'member', ...groupScope(opts.groupId) },
        include: withGroups,
    });

    const rows: StatsRow[] = [];
    for (const m of members) {
        const window = lastNDates(safeTz(m.timezone), days);
        const records = await db.mealRecord.findMany({
            where: { memberId: m.id, date: { in: window } },
            select: { status: true },
        });
        const expected = days * MEAL_TYPES.length;
        const done = records.length;
        rows.push({
            ...brief(m),
            expected,
            done,
            late: records.filter(r => r.status === 'late').length,
            missed: expected - done,
            rate: expected ? Math.round((done / expected) * 100) : 0,
        });
    }

    rows.sort((a, b) => b.rate - a.rate);
    const tz = safeTz(tenant.timezone);
    return { rows, days, from: daysAgoIn(tz, days - 1), to: todayIn(tz) };
}

/// Bitta a'zoning kunma-kun hisoboti
export async function memberReport(db: TenantClient, memberId: string, days = 7) {
    const member = await db.member.findUnique({ where: { id: memberId }, include: withGroups });
    if (!member) return null;

    const tz = safeTz(member.timezone);
    const window = lastNDates(tz, days);
    const records = await db.mealRecord.findMany({
        where: { memberId: member.id, date: { in: window } },
        orderBy: { date: 'asc' },
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

/// A'zolarni ism/username bo'yicha izlash.
/// SQLite'da `mode: 'insensitive'` yo'q — shuning uchun nameLc ustuni ishlatiladi.
export async function searchMembers(db: TenantClient, query: string): Promise<MemberBrief[]> {
    const q = query.trim();
    if (!q) return [];
    const lc = q.toLowerCase();
    const members = await db.member.findMany({
        where: { OR: [{ nameLc: { contains: lc } }, { telegramId: q }] },
        include: withGroups,
        take: 25,
    });

    // username uchun alohida — kichik harfga keltirib qo'lda solishtiramiz
    const byUsername = await db.member.findMany({
        where: { username: { not: null } },
        include: withGroups,
        take: 200,
    });
    const extra = byUsername.filter(
        m => (m.username ?? '').toLowerCase().includes(lc) && !members.some(x => x.id === m.id),
    );

    return [...members, ...extra].slice(0, 25).map(brief);
}

// ============ MATNGA AYLANTIRISH ============

/// Yubormaganlar ro'yxati — GURUHLAR BO'YICHA guruhlab ko'rsatiladi,
/// shunda murabbiy bir qarashda qaysi guruhda muammo borligini ko'radi.
export function formatInactive(rows: InactiveRow[], days: number, totalGroups: number): string {
    if (rows.length === 0) {
        return `✅ Oxirgi ${days} kunda barcha guruhlarda hamma o'z ratsionini yuborgan. Ajoyib!`;
    }

    const byGroup = new Map<string, InactiveRow[]>();
    for (const r of rows) {
        const keys = r.groups.length ? r.groups : ['(guruhsiz)'];
        for (const k of keys) {
            if (!byGroup.has(k)) byGroup.set(k, []);
            byGroup.get(k)!.push(r);
        }
    }

    const lines: string[] = [
        `⚠️ <b>Oxirgi ${days} kunda yubormaganlar</b>`,
        `Jami <b>${rows.length}</b> kishi · ${byGroup.size}/${totalGroups} guruhda`,
    ];

    for (const [groupName, members] of [...byGroup.entries()].sort((a, b) => b[1].length - a[1].length)) {
        lines.push('', `<b>${esc(groupName)}</b> — ${members.length} kishi`);
        for (const r of members) {
            const since = r.daysSince === null ? 'hech qachon' : `${r.daysSince} kun`;
            lines.push(`  • ${esc(r.name)} <i>(${since})</i>`);
        }
    }

    return lines.join('\n');
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

/// Bugun yubormaganlar — guruhlar bo'yicha, qaysi ovqat yetishmayotgani bilan
export function formatMissingToday(rows: Array<MemberBrief & { missing: MealType[] }>): string {
    if (rows.length === 0) return '✅ Bugun barcha guruhlarda hamma ovqatini yuborgan.';

    const byGroup = new Map<string, Array<MemberBrief & { missing: MealType[] }>>();
    for (const r of rows) {
        for (const k of r.groups.length ? r.groups : ['(guruhsiz)']) {
            if (!byGroup.has(k)) byGroup.set(k, []);
            byGroup.get(k)!.push(r);
        }
    }

    const lines: string[] = [`⏳ <b>Bugun to'liq yubormaganlar — ${rows.length} kishi</b>`];
    for (const [groupName, members] of [...byGroup.entries()].sort((a, b) => b[1].length - a[1].length)) {
        lines.push('', `<b>${esc(groupName)}</b>`);
        for (const r of members) {
            lines.push(`  • ${esc(r.name)} — ${r.missing.map(m => MEAL_LABELS[m]).join(', ')}`);
        }
    }
    return lines.join('\n');
}
