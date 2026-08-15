import { Markup } from 'telegraf';
import { webappUrl } from '../core/env';

/// Barcha menyular inline tugmalarda — foydalanuvchi buyruq yodlamaydi.

export function coachMenu(tenantId: string) {
    const rows: any[] = [
        [Markup.button.callback("⚠️ Yubormaganlar", 'c:inactive:2')],
        [
            Markup.button.callback('📊 Bugungi holat', 'c:today'),
            Markup.button.callback('📈 Reyting', 'c:stats:7'),
        ],
        [
            Markup.button.callback("👥 A'zolar", 'c:members'),
            Markup.button.callback('🏠 Guruhlar', 'c:groups'),
        ],
        [
            Markup.button.callback('⚙️ Sozlamalar', 'c:settings'),
            Markup.button.callback('🔌 Business', 'c:business'),
        ],
    ];
    const url = webappUrl(tenantId);
    if (url) rows.push([Markup.button.webApp('📱 Mini ilova', url)]);
    return Markup.inlineKeyboard(rows);
}

export function memberMenu(tenantId: string) {
    const rows: any[] = [
        [Markup.button.callback('📊 Mening natijam', 'm:me')],
        [Markup.button.callback('🔔 Eslatmalar', 'm:reminders')],
    ];
    const url = webappUrl(tenantId);
    if (url) rows.push([Markup.button.webApp('📱 Mini ilova', url)]);
    return Markup.inlineKeyboard(rows);
}

export function backTo(action: string, label = '⬅️ Orqaga') {
    return Markup.inlineKeyboard([[Markup.button.callback(label, action)]]);
}

/// Yubormaganlar ekrani — kun oynasi va guruh filtri bilan.
/// Standart holat: BARCHA guruhlar (murabbiyga aynan shu kerak).
export function inactiveMenu(days: number, groupId: string | null) {
    const day = (n: number) =>
        Markup.button.callback(n === days ? `· ${n} kun ·` : `${n} kun`, `c:inactive:${n}`);
    return Markup.inlineKeyboard([
        [day(1), day(2), day(3), day(7)],
        [
            Markup.button.callback(
                groupId ? '🏠 Bitta guruh — hammasiga qaytish' : '✅ Barcha guruhlar',
                groupId ? `c:inactive:${days}` : 'c:pickgroup',
            ),
        ],
        [Markup.button.callback('✉️ Ularga ogohlantirish yuborish', 'c:warn')],
        [Markup.button.callback('⬅️ Menyu', 'c:menu')],
    ]);
}

export function statsMenu(days: number) {
    const opt = (n: number) =>
        Markup.button.callback(n === days ? `· ${n} kun ·` : `${n} kun`, `c:stats:${n}`);
    return Markup.inlineKeyboard([[opt(7), opt(14), opt(30)], [Markup.button.callback('⬅️ Menyu', 'c:menu')]]);
}

export function settingsMenu(t: {
    breakfastTime: string;
    lunchTime: string;
    dinnerTime: string;
    reminderInterval: number;
    maxReminders: number;
    requirePhoto: boolean;
}) {
    return Markup.inlineKeyboard([
        [Markup.button.callback(`🌅 Nonushta — ${t.breakfastTime}`, 'c:set:breakfastTime')],
        [Markup.button.callback(`🌞 Tushlik — ${t.lunchTime}`, 'c:set:lunchTime')],
        [Markup.button.callback(`🌙 Kechki — ${t.dinnerTime}`, 'c:set:dinnerTime')],
        [
            Markup.button.callback(`⏱ Interval — ${t.reminderInterval}d`, 'c:set:reminderInterval'),
            Markup.button.callback(`🔁 Maks — ${t.maxReminders}`, 'c:set:maxReminders'),
        ],
        [Markup.button.callback(`📷 Rasm majburiy: ${t.requirePhoto ? 'ha' : "yo'q"}`, 'c:toggle:requirePhoto')],
        [Markup.button.callback('⬅️ Menyu', 'c:menu')],
    ]);
}
