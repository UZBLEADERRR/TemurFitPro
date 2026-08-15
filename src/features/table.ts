import type { Group, Tenant } from '@prisma/client';
import { prisma } from '../core/db';
import { getBotByTenant } from '../core/registry';
import { MEAL_TYPES, MealType } from '../core/meals';
import { todayIn, safeTz } from '../core/time';
import { tgError, withRetry, esc } from '../core/telegram';
import { webappUrl } from '../core/env';
import { log } from '../core/logger';

const MARK_DONE = '🟢';
const MARK_LATE = '🟡';
const MARK_MISS = '⚪️';

interface Row {
    name: string;
    marks: Record<MealType, string>;
}

/// Guruhning bugungi holatini qatorlarga yig'ish.
/// Har bir a'zoning sanasi O'ZINING vaqt mintaqasida hisoblanadi —
/// Koreyadagi va O'zbekistondagi a'zolar bir jadvalda to'g'ri ko'rinadi.
async function buildRows(tenant: Tenant, group: Group): Promise<Row[]> {
    const links = await prisma.groupMember.findMany({
        where: { groupId: group.id, member: { status: 'active' } },
        include: { member: true },
        orderBy: { joinedAt: 'asc' },
    });

    const rows: Row[] = [];
    for (const link of links) {
        const member = link.member;
        const date = todayIn(safeTz(member.timezone));
        const records = await prisma.mealRecord.findMany({
            where: { memberId: member.id, date },
        });
        const marks = {} as Record<MealType, string>;
        for (const meal of MEAL_TYPES) {
            const rec = records.find(r => r.mealType === meal);
            marks[meal] = !rec ? MARK_MISS : rec.status === 'late' ? MARK_LATE : MARK_DONE;
        }
        rows.push({ name: member.name, marks });
    }
    return rows;
}

export async function renderTable(tenant: Tenant, group: Group): Promise<string> {
    const rows = await buildRows(tenant, group);
    const dateStr = todayIn(safeTz(tenant.timezone));

    const header = [
        `<b>💪 ${esc(group.title || 'Ratsion jadvali')}</b>`,
        `📅 ${dateStr}`,
        '',
    ];

    if (rows.length === 0) {
        return [...header, "Hali a'zolar yo'q. Botga /start bosib ro'yxatdan o'ting."].join('\n');
    }

    const width = Math.min(14, Math.max(...rows.map(r => r.name.length)));
    const body = rows.map((r, i) => {
        const name = esc(r.name.slice(0, width).padEnd(width));
        return `<code>${String(i + 1).padStart(2)}. ${name}</code> ${r.marks.nonushta}${r.marks.tushlik}${r.marks.kechki}`;
    });

    const done = rows.filter(r => MEAL_TYPES.every(m => r.marks[m] !== MARK_MISS)).length;

    return [
        ...header,
        `<code>     ${''.padEnd(width)} N T K</code>`,
        ...body,
        '',
        `${MARK_DONE} vaqtida · ${MARK_LATE} kech · ${MARK_MISS} yo'q`,
        `✅ To'liq bajardi: <b>${done}/${rows.length}</b>`,
    ].join('\n');
}

function keyboard(tenantId: string) {
    const url = webappUrl(tenantId);
    if (!url) return undefined;
    return { inline_keyboard: [[{ text: '📊 Batafsil statistika', url }]] };
}

/// Pinlangan jadvalni yangilash. Xabar o'chirilgan bo'lsa — qaytadan yaratib pinlaydi.
export async function updateGroupTable(tenant: Tenant, group: Group): Promise<void> {
    const bot = getBotByTenant(tenant.id);
    if (!bot) return;

    const text = await renderTable(tenant, group);
    const reply_markup = keyboard(tenant.id);

    if (group.pinnedMessageId) {
        try {
            await bot.telegram.editMessageText(group.chatId, group.pinnedMessageId, undefined, text, {
                parse_mode: 'HTML',
                reply_markup,
            });
            return;
        } catch (e) {
            const desc = tgError(e);
            // Matn o'zgarmagan bo'lsa — bu xato emas
            if (desc.includes('message is not modified')) return;
            if (!desc.includes('message to edit not found') && !desc.includes("message can't be edited")) {
                log.warn('table', `jadval yangilanmadi (${group.chatId}): ${desc}`);
                return;
            }
            // pastda yangisini yaratamiz
        }
    }

    await createAndPinTable(tenant, group, text);
}

export async function createAndPinTable(tenant: Tenant, group: Group, text?: string): Promise<void> {
    const bot = getBotByTenant(tenant.id);
    if (!bot) return;
    const body = text ?? (await renderTable(tenant, group));

    try {
        const msg = await withRetry(() =>
            bot.telegram.sendMessage(group.chatId, body, {
                parse_mode: 'HTML',
                reply_markup: keyboard(tenant.id),
            }),
        );
        try {
            await bot.telegram.pinChatMessage(group.chatId, msg.message_id, { disable_notification: true });
        } catch (e) {
            log.warn('table', `pin qilinmadi (${group.chatId}): ${tgError(e)}`);
        }
        await prisma.group.update({
            where: { id: group.id },
            data: { pinnedMessageId: msg.message_id, lastTableDate: todayIn(safeTz(tenant.timezone)) },
        });
    } catch (e) {
        log.error('table', `jadval yuborilmadi (${group.chatId}): ${tgError(e)}`);
    }
}

/// Bitta a'zo ovqat yuborgach — u a'zo bo'lgan barcha guruhlar jadvalini yangilash
export async function refreshTablesForMember(tenant: Tenant, memberId: string): Promise<void> {
    const links = await prisma.groupMember.findMany({
        where: { memberId, group: { isActive: true } },
        include: { group: true },
    });
    for (const link of links) {
        await updateGroupTable(tenant, link.group).catch(e =>
            log.warn('table', `refresh xatosi: ${tgError(e)}`),
        );
    }
}
