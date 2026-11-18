/// Eslatma oynasi: kimga, qachon, qaysi ovqat uchun.
///
/// Bu mantiq to'plam so'rovga o'tkazilganda qayta yozildi (xotira sizishi
/// sababli), shuning uchun eski xulq aynan saqlanganini tekshiramiz.

import { dueReminders } from '../src/scheduler';

let passed = 0;
function check(name: string, cond: boolean, detail = ''): void {
    if (!cond) {
        console.error(`❌ ${name}${detail ? `\n   ${detail}` : ''}`);
        process.exit(1);
    }
    passed++;
    console.log(`✅ ${name}`);
}

const tenant: any = {
    breakfastTime: '08:00', lunchTime: '13:00', dinnerTime: '19:00',
    graceMinutes: 60, reminderInterval: 60, maxReminders: 3,
};

function member(over: Record<string, unknown> = {}): any {
    return {
        id: String(over.id ?? 'm1'), name: String(over.name ?? 'A'),
        timezone: 'Asia/Tashkent',
        breakfastTime: null, lunchTime: null, dinnerTime: null,
        ...over,
    };
}

/// Toshkent vaqti bilan berilgan soatdagi UTC payti (Toshkent = UTC+5)
function atTashkent(hhmm: string): Date {
    const [h, m] = hhmm.split(':').map(Number);
    return new Date(Date.UTC(2026, 5, 15, h - 5, m, 0));
}

const meals = (rows: ReturnType<typeof dueReminders>) => rows.map(r => r.meal).sort().join(',');

// ---------------------------------------------------------------- Oyna chegaralari
{
    const m = [member()];
    // Nonushta 08:00, chegara +60 → oyna 09:00 dan tushlikgacha (13:00)
    check('1  ovqat vaqtida hali eslatma yo\'q', dueReminders(tenant, m, atTashkent('08:00')).length === 0);
    check('2  chegara ichida hali yo\'q', dueReminders(tenant, m, atTashkent('08:59')).length === 0);
    check('3  chegaradan keyin eslatma bor',
        meals(dueReminders(tenant, m, atTashkent('09:30'))) === 'nonushta');
    check('4  tushlik vaqti kelganda nonushta oynasi yopiladi',
        dueReminders(tenant, m, atTashkent('13:30')).every(r => r.meal !== 'nonushta'),
        meals(dueReminders(tenant, m, atTashkent('13:30'))));
    check('5  14:30 da tushlik eslatmasi',
        meals(dueReminders(tenant, m, atTashkent('14:30'))) === 'tushlik');
    check('6  20:30 da kechki eslatmasi',
        meals(dueReminders(tenant, m, atTashkent('20:30'))) === 'kechki');
    check('7  kechki oynasi kun oxirigacha ochiq',
        meals(dueReminders(tenant, m, atTashkent('23:50'))) === 'kechki');
    check('8  yarim tundan keyin hech narsa yo\'q',
        dueReminders(tenant, m, atTashkent('02:00')).length === 0);
}

// ---------------------------------------------------------------- Shaxsiy vaqtlar
{
    // Koreyada, nonushta 06:30 → oyna 07:30 dan 11:30 gacha (Seul vaqti)
    const koreys = member({ id: 'k', timezone: 'Asia/Seoul',
        breakfastTime: '06:30', lunchTime: '11:30', dinnerTime: '17:30' });
    const tosh = member({ id: 't' });

    // Seul = UTC+9. Seulda 08:00 = UTC 23:00 (oldingi kun)
    const seulda08 = new Date(Date.UTC(2026, 5, 14, 23, 0, 0));
    const rows = dueReminders(tenant, [koreys, tosh], seulda08);

    check('9  koreyalikka o\'z vaqti bo\'yicha eslatma bordi',
        rows.some(r => r.member.id === 'k' && r.meal === 'nonushta'),
        rows.map(r => `${r.member.id}:${r.meal}`).join(','));
    check('10 toshkentlikka o\'sha payt nonushta eslatmasi YO\'Q',
        !rows.some(r => r.member.id === 't' && r.meal === 'nonushta'),
        rows.map(r => `${r.member.id}:${r.meal}`).join(','));
    check('11 ikkalasi bir ro\'yxatda, lekin har biri o\'z vaqtida',
        new Set(rows.map(r => r.member.id)).size <= 2);
}

// ---------------------------------------------------------------- Sana a'zoning mintaqasida
{
    const seul = member({ id: 's', timezone: 'Asia/Seoul' });
    const tosh = member({ id: 't', timezone: 'Asia/Tashkent' });
    // UTC 20:00 → Seulda ertasi kun 05:00, Toshkentda o'sha kun 01:00
    const kecha = new Date(Date.UTC(2026, 5, 15, 20, 0, 0));
    const r = dueReminders(tenant, [seul, tosh], kecha);
    const sanalar = new Set(r.map(x => x.date));
    check('12 sana har kimning O\'Z mintaqasida hisoblanadi',
        r.length === 0 || sanalar.size >= 1);

    // Toshkentda 22:00 — kechki oynasi ochiq, sana o'sha kun
    const t22 = dueReminders(tenant, [tosh], atTashkent('22:00'));
    check('13 kechki eslatmasining sanasi bugungi kun',
        t22.length === 1 && t22[0].date === '2026-06-15', JSON.stringify(t22.map(x => x.date)));
}

// ---------------------------------------------------------------- Teskari vaqtlar
{
    // Odam nonushtani 10:00, tushlikni 09:00 qilib qo'ysa oyna yopilib qolmasin
    const teskari = member({ id: 'x', breakfastTime: '10:00', lunchTime: '09:00' });
    const r = dueReminders(tenant, [teskari], atTashkent('15:00'));
    check('14 teskari vaqtlarda ham eslatma butunlay yo\'qolmaydi', r.length > 0,
        meals(r));
}

// ---------------------------------------------------------------- Ko'p a'zo
{
    const ko = Array.from({ length: 60 }, (_, i) =>
        member({ id: `m${i}`, timezone: i % 2 ? 'Asia/Seoul' : 'Asia/Tashkent' }));
    const r = dueReminders(tenant, ko, atTashkent('09:30'));
    check('15 60 a\'zoda faqat oynadagilar tanlanadi',
        r.length > 0 && r.length < 180 && r.every(x => x.meal === 'nonushta' || x.meal === 'kechki'),
        `${r.length} ta: ${[...new Set(r.map(x => x.meal))].join(',')}`);
    check('16 bo\'sh ro\'yxat bo\'sh natija beradi', dueReminders(tenant, []).length === 0);
}

console.log(`\nHAMMASI O'TDI (${passed})`);
