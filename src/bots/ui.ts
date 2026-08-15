import { Markup } from 'telegraf';
import { webappUrl } from '../core/env';

/// Barcha menyular inline tugmalarda — foydalanuvchi hech qanday buyruq yodlamaydi.

export function coachMenu(tenantId: string, agentName: string) {
    const rows: any[] = [
        [
            Markup.button.callback('📊 Bugungi holat', 'c:today'),
            Markup.button.callback('⚠️ Yubormaganlar', 'c:inactive:2'),
        ],
        [
            Markup.button.callback('📈 Statistika', 'c:stats:7'),
            Markup.button.callback("👥 A'zolar", 'c:members'),
        ],
        [
            Markup.button.callback('⚙️ Sozlamalar', 'c:settings'),
            Markup.button.callback('🔌 Business', 'c:business'),
        ],
        [Markup.button.callback(`🤖 ${agentName} bilan suhbat`, 'c:ai')],
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

export function inactiveMenu() {
    return Markup.inlineKeyboard([
        [
            Markup.button.callback('1 kun', 'c:inactive:1'),
            Markup.button.callback('2 kun', 'c:inactive:2'),
            Markup.button.callback('3 kun', 'c:inactive:3'),
            Markup.button.callback('7 kun', 'c:inactive:7'),
        ],
        [Markup.button.callback('✉️ Ularga ogohlantirish yuborish', 'c:warn')],
        [Markup.button.callback('⬅️ Menyu', 'c:menu')],
    ]);
}

export function statsMenu() {
    return Markup.inlineKeyboard([
        [
            Markup.button.callback('7 kun', 'c:stats:7'),
            Markup.button.callback('14 kun', 'c:stats:14'),
            Markup.button.callback('30 kun', 'c:stats:30'),
        ],
        [Markup.button.callback('⬅️ Menyu', 'c:menu')],
    ]);
}

export function settingsMenu(t: {
    breakfastTime: string; lunchTime: string; dinnerTime: string;
    reminderInterval: number; maxReminders: number; agentName: string;
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
        [Markup.button.callback(`🤖 AI ismi — ${t.agentName}`, 'c:set:agentName')],
        [Markup.button.callback('✍️ Yozish uslubim', 'c:set:coachStyle')],
        [Markup.button.callback('⬅️ Menyu', 'c:menu')],
    ]);
}
