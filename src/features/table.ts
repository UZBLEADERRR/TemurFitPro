import type { Tenant } from '../generated/platform';
import type { TenantClient } from '../core/db';
import type { Group } from '../generated/tenant';
import { tenantDb } from '../core/db';
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
async function buildRows(db: TenantClient, group: Group): Promise<Row[]> {
    const links = await db.groupMember.findMany({
        where: { groupId: group.id, member: { status: 'active' } },
        include: { member: true },
        orderBy: { joinedAt: 'asc' },
    });

    const rows: Row[] = [];
    for (const link of links) {
        const member = link.member;
        const date = todayIn(safeTz(member.timezone));
        const records = await db.mealRecord.findMany({ where: { memberId: member.id, date } });
        const marks = {} as Record<MealType, string>;
        for (const meal of MEAL_TYPES) {
            const rec = records.find(r => r.mealType === meal);
            marks[meal] = !rec ? MARK_MISS : rec.status === 'late' ? MARK_LATE : MARK_DONE;
        }
        rows.push({ name: member.name, marks });
    }
    return rows;
}

export async function renderTable(db: TenantClient, tenant: Tenant, group: Group): Promise<string> {
    const rows = await buildRows(db, group);
    const dateStr = todayIn(safeTz(tenant.timezone));

    const header = [`<b>💪 ${esc(group.title || 'Ratsion jadvali')}</b>`, `📅 ${dateStr}`, ''];

    if (rows.length === 0) {
        return [...header, "Hali a'zolar yo'q. Guruhga ovqat rasmini hashtag bilan yuboring."].join('\n');
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
export async function updateGroupTable(db: TenantClient, tenant: Tenant, group: Group): Promise<void> {
    const bot = getBotByTenant(tenant.id);
    if (!bot) return;

    const text = await renderTable(db, tenant, group);
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
            if (desc.includes('message is not modified')) return;
            if (!desc.includes('message to edit not found') && !desc.includes("message can't be edited")) {
                log.warn('table', `jadval yangilanmadi (${group.chatId}): ${desc}`);
                return;
            }
            // pastda yangisini yaratamiz
        }
    }

    await createAndPinTable(db, tenant, group, text);
}

export async function createAndPinTable(
    db: TenantClient,
    tenant: Tenant,
    group: Group,
    text?: string,
): Promise<void> {
    const bot = getBotByTenant(tenant.id);
    if (!bot) return;
    const body = text ?? (await renderTable(db, tenant, group));

    try {
        const msg = await withRetry(() =>
            bot.telegram.sendMessage(group.chatId, body, { parse_mode: 'HTML', reply_markup: keyboard(tenant.id) }),
        );
        try {
            await bot.telegram.pinChatMessage(group.chatId, msg.message_id, { disable_notification: true });
        } catch (e) {
            log.warn('table', `pin qilinmadi (${group.chatId}): ${tgError(e)}`);
        }
        await db.group.update({
            where: { id: group.id },
            data: { pinnedMessageId: msg.message_id, lastTableDate: todayIn(safeTz(tenant.timezone)) },
        });
    } catch (e) {
        log.error('table', `jadval yuborilmadi (${group.chatId}): ${tgError(e)}`);
    }
}

/// Bitta a'zo ovqat yuborgach — u a'zo bo'lgan barcha guruhlar jadvalini yangilash
export async function refreshTablesForMember(tenant: Tenant, memberId: string): Promise<void> {
    const db = await tenantDb(tenant.botId);
    const links = await db.groupMember.findMany({
        where: { memberId, group: { isActive: true } },
        include: { group: true },
    });
    for (const link of links) {
        await updateGroupTable(db, tenant, link.group).catch(e =>
            log.warn('table', `refresh xatosi: ${tgError(e)}`),
        );
    }
}
