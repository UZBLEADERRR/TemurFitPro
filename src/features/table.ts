import type { Tenant } from '../generated/platform';
import type { TenantClient } from '../core/db';
import type { Group } from '../generated/tenant';
import { tenantDb } from '../core/db';
import { getBotByTenant } from '../core/registry';
import { MEAL_TYPES, MealType } from '../core/meals';
import { todayIn, safeTz } from '../core/time';
import { tgError, withRetry, esc, safeText, truncate, padVisual, visualLength, isChatGone } from '../core/telegram';
import { log } from '../core/logger';
import { LIVE_GROUP, GROUP_PARTICIPANT } from '../core/groups';
import { markGroupLeft } from '../core/tenants';

// Belgilar ataylab oddiy: rangli doirachalar ikki barobar keng chiziladi va
// <code> ichidagi ustunni surib yuboradi. Bular esa bir xil kenglikda turadi.
const MARK_DONE = '+';
const MARK_LATE = '~';
const MARK_MISS = '·';

interface Row {
    name: string;
    marks: Record<MealType, string>;
}

/// Guruhning bugungi holatini qatorlarga yig'ish.
/// Har bir a'zoning sanasi O'ZINING vaqt mintaqasida hisoblanadi —
/// Koreyadagi va O'zbekistondagi a'zolar bir jadvalda to'g'ri ko'rinadi.
async function buildRows(db: TenantClient, group: Group): Promise<Row[]> {
    const links = await db.groupMember.findMany({
        where: { groupId: group.id, ...GROUP_PARTICIPANT },
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

    const header = [`<b>${esc(group.title || 'Ratsion jadvali')}</b>`, dateStr, ''];

    if (rows.length === 0) {
        return safeText([...header, "Hali qayd yo'q."].join('\n'));
    }

    // DIQQAT: uzunlik kod NUQTALARI bo'yicha o'lchanadi, kod birliklari bo'yicha emas.
    // Aks holda ismdagi emoji surrogat juftligining o'rtasidan kesilib, Telegram
    // butun xabarni "text must be encoded in UTF-8" deb rad etadi.
    const width = Math.min(14, Math.max(...rows.map(r => visualLength(r.name))));
    const body = rows.map((r, i) => {
        const name = esc(padVisual(truncate(r.name, width), width));
        return `<code>${String(i + 1).padStart(2)}. ${name}</code> ${r.marks.nonushta}${r.marks.tushlik}${r.marks.kechki}`;
    });

    const done = rows.filter(r => MEAL_TYPES.every(m => r.marks[m] !== MARK_MISS)).length;

    return safeText(
        [
            ...header,
            `<code>     ${' '.repeat(width)} N T K</code>`,
            ...body,
            '',
            `<code>${MARK_DONE}</code> vaqtida · <code>${MARK_LATE}</code> kech · <code>${MARK_MISS}</code> yo'q`,
            `To'liq bajardi: <b>${done}/${rows.length}</b>`,
        ].join('\n'),
    );
}

// Guruhdagi jadvalda TUGMA YO'Q.
//
// Ilgari "Batafsil statistika" tugmasi turardi, lekin u oddiy havola edi:
// bosilganda mini ilova brauzerda ochilardi, Telegram initData'siz esa u
// "Havola noto'g'ri" deb xato beradi. Ya'ni tugma hech qachon ishlamagan.
// Mini ilova murabbiyga shaxsiy chatdagi tugma orqali ochiladi.

/// Pinlangan jadvalni yangilash. Xabar o'chirilgan bo'lsa — qaytadan yaratib pinlaydi.
export async function updateGroupTable(db: TenantClient, tenant: Tenant, group: Group): Promise<void> {
    const bot = getBotByTenant(tenant.id);
    if (!bot) return;

    const text = await renderTable(db, tenant, group);

    if (group.pinnedMessageId) {
        try {
            await bot.telegram.editMessageText(group.chatId, group.pinnedMessageId, undefined, text, {
                parse_mode: 'HTML',
            });
            return;
        } catch (e) {
            const desc = tgError(e);
            if (desc.includes('message is not modified')) return;
            if (await handleChatGone(e, tenant, group)) return;
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
            bot.telegram.sendMessage(group.chatId, body, { parse_mode: 'HTML' }),
        );
        // Pin faqat jadval YANGIDAN yaratilganda. Kundalik yangilanish
        // mavjud xabarni tahrirlaydi, shuning uchun guruhda "X pinned a
        // message" xizmat xabari qayta-qayta chiqmaydi.
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
        if (await handleChatGone(e, tenant, group)) return;
        log.error('table', `jadval yuborilmadi (${group.chatId}): ${tgError(e)}`);
    }
}

/// Bot guruhdan chiqarilgan/guruh o'chirilgan bo'lsa — uni "faol emas" deb
/// belgilaymiz. Busiz scheduler har kuni o'sha "chat not found" ni qayta-qayta
/// yozib, loglarni to'ldirib yuboradi va haqiqiy xatolar ko'rinmay qoladi.
async function handleChatGone(e: unknown, tenant: Tenant, group: Group): Promise<boolean> {
    if (!isChatGone(e)) return false;
    await markGroupLeft(tenant, group.chatId).catch(() => undefined);
    log.warn('table', `guruh yetib bo'lmaydi, faol emas deb belgilandi (${group.chatId}): ${tgError(e)}`);
    return true;
}

/// Bitta a'zo ovqat yuborgach — u a'zo bo'lgan barcha guruhlar jadvalini yangilash
export async function refreshTablesForMember(tenant: Tenant, memberId: string): Promise<void> {
    const db = await tenantDb(tenant.botId);
    const links = await db.groupMember.findMany({
        where: { memberId, group: LIVE_GROUP },
        include: { group: true },
    });
    for (const link of links) {
        await updateGroupTable(db, tenant, link.group).catch(e =>
            log.warn('table', `refresh xatosi: ${tgError(e)}`),
        );
    }
}
