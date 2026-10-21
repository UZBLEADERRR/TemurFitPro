/// Shaxsiy ovqat vaqtlari va bosqich tabriklari.
///
/// Va'da: "Koreyadaman, lokatsiya yuboraman, o'zimga qulay 3 ta vaqt
/// tanlayman — bot shunga qarab eslatadi" va "har 10 kunda tabriklaymiz".

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tfp-sch-'));
fs.mkdirSync(path.join(dir, 'tenants'), { recursive: true });
const root = path.join(__dirname, '..');

execFileSync(
    'npx',
    ['prisma', 'db', 'push', '--schema', 'prisma/platform.prisma', '--skip-generate', '--accept-data-loss'],
    { env: { ...process.env, PLATFORM_DATABASE_URL: `file:${path.join(dir, 'platform.db')}` }, cwd: root, stdio: 'ignore' },
);

process.env.DATA_DIR = dir;
process.env.CONTROL_BOT_TOKEN = '1:test';
delete process.env.RAILWAY_VOLUME_MOUNT_PATH;

const { prisma, tenantDb } = require('../src/core/db');
const { encrypt } = require('../src/core/crypto');
const meals = require('../src/core/meals');
const { dayNumber, buildMessage } = require('../src/features/milestone');
const { unpackTime, packTime } = require('../src/features/onboarding');

let passed = 0;
function check(name: string, cond: boolean, detail = ''): void {
    if (!cond) {
        console.error(`❌ ${name}${detail ? `\n   ${detail}` : ''}`);
        process.exit(1);
    }
    passed++;
    console.log(`✅ ${name}`);
}

const BOT_ID = '777004';

async function main() {
    const tenant = await prisma.tenant.create({
        data: {
            botId: BOT_ID, botUsername: 'sch_bot', botUsernameLc: 'sch_bot',
            botTokenEnc: encrypt(`${BOT_ID}:AAtest`), webhookSecret: 's', createdByTgId: '1',
            breakfastTime: '08:00', lunchTime: '13:00', dinnerTime: '19:00',
        },
    });
    const db = await tenantDb(BOT_ID);

    // ---------- Vaqtlarni o'qish ----------
    const standart = { breakfastTime: null, lunchTime: null, dinnerTime: null };
    const koreys = { breakfastTime: '06:30', lunchTime: '11:30', dinnerTime: '17:30' };

    check('1  vaqt qo\'ymagan a\'zoga botning umumiy vaqti',
        JSON.stringify(meals.mealTimesFor(tenant, standart)) ===
        JSON.stringify({ nonushta: '08:00', tushlik: '13:00', kechki: '19:00' }));

    check('2  shaxsiy vaqt qo\'ygan a\'zoga O\'ZINIKI',
        JSON.stringify(meals.mealTimesFor(tenant, koreys)) ===
        JSON.stringify({ nonushta: '06:30', tushlik: '11:30', kechki: '17:30' }));

    check('3  qisman qo\'yilgan bo\'lsa qolgani umumiydan',
        JSON.stringify(meals.mealTimesFor(tenant, { lunchTime: '12:15' })) ===
        JSON.stringify({ nonushta: '08:00', tushlik: '12:15', kechki: '19:00' }));

    check('4  a\'zoni berilmasa ham ishlaydi (eski chaqiruvlar)',
        meals.mealTargetMinutes(tenant, 'nonushta') === 8 * 60);

    check('5  shaxsiy vaqt daqiqaga to\'g\'ri aylanadi',
        meals.mealTargetMinutes(tenant, 'nonushta', koreys) === 6 * 60 + 30);

    check('6  hasOwnTimes farqlaydi',
        meals.hasOwnTimes(koreys) && !meals.hasOwnTimes(standart) && !meals.hasOwnTimes(null));

    // ---------- Eslatma oynasi ----------
    check('7  nonushta oynasi tushlikkacha', meals.mealWindowEnd(tenant, 'nonushta', koreys) === 11 * 60 + 30);
    check('8  kechki oynasi kun oxirigacha', meals.mealWindowEnd(tenant, 'kechki', koreys) === 23 * 60 + 59);

    // Teskari tartib qo'yilsa oyna yopilib qolmasin
    const teskari = { breakfastTime: '10:00', lunchTime: '09:00', dinnerTime: '19:00' };
    check('9  vaqtlar teskari qo\'yilsa ham eslatma oynasi yopilmaydi',
        meals.mealWindowEnd(tenant, 'nonushta', teskari) === 23 * 60 + 59,
        String(meals.mealWindowEnd(tenant, 'nonushta', teskari)));

    // ---------- Vaqt kiritishni tushunish ----------
    const n = meals.normalizeTime;
    check('10 "8" → 08:00', n('8') === '08:00');
    check('11 "8:5" → 08:05', n('8:5') === '08:05');
    check('12 "08.30" → 08:30', n('08.30') === '08:30');
    check('13 "20 15" → 20:15', n('20 15') === '20:15');
    check('14 "25:00" rad etiladi', n('25:00') === null);
    check('15 "salom" rad etiladi', n('salom') === null);
    check('16 "08:70" rad etiladi', n('08:70') === null);

    // ---------- Callback paketlash (":" muammosi) ----------
    check('17 vaqt callback\'da ":"siz uzatiladi', packTime('08:30') === '0830' && !packTime('08:30').includes(':'));
    check('18 qaytib ochiladi', unpackTime('0830') === '08:30');
    check('19 skip null beradi', unpackTime('skip') === null);
    check('20 buzuq qiymat null', unpackTime('9999') === null);

    // ---------- Shaxsiy vaqt bazaga yozilishi ----------
    const dilnoza = await db.member.create({
        data: {
            telegramId: '5001', name: 'Dilnoza', nameLc: 'dilnoza',
            timezone: 'Asia/Seoul', breakfastTime: '06:30', lunchTime: '11:30', dinnerTime: '17:30',
            setupDone: true,
        },
    });
    const jasur = await db.member.create({
        data: { telegramId: '5002', name: 'Jasur', nameLc: 'jasur', timezone: 'Asia/Tashkent' },
    });

    const okilgan = await db.member.findUnique({ where: { telegramId: '5001' } });
    check('21 shaxsiy vaqtlar bazada saqlanadi',
        okilgan.breakfastTime === '06:30' && okilgan.setupDone === true);
    check('22 sozlamagan a\'zoda null turadi',
        jasur.breakfastTime === null && jasur.setupDone === false);

    // Ikkisi bir guruhda, lekin har biriga o'z vaqti
    check('23 bir guruhdagi ikki a\'zoga boshqa-boshqa vaqt',
        meals.mealTargetMinutes(tenant, 'nonushta', okilgan) !==
        meals.mealTargetMinutes(tenant, 'nonushta', jasur));

    // ---------- Kun hisobi ----------
    const kun = (ozgarish: number) => {
        const joined = new Date(Date.now() - ozgarish * 86400_000);
        return dayNumber(joined, 'Asia/Seoul');
    };
    check('24 qo\'shilgan kun = 1-kun', kun(0) === 1, String(kun(0)));
    check('25 9 kundan keyin = 10-kun', kun(9) === 10, String(kun(9)));
    check('26 39 kundan keyin = 40-kun', kun(39) === 40, String(kun(39)));

    // ---------- Bosqich qaysi kunlarda ----------
    const every = 10;
    const bosqich = (d: number) => d >= every && d % every === 0;
    check('27 tabrik 10, 20, 30, 40-kunlarda',
        [10, 20, 30, 40].every(bosqich) && ![1, 9, 11, 25].some(bosqich));
    check('28 1-kunda tabrik yo\'q', !bosqich(1));

    // ---------- Tabrik matni ----------
    const matn = buildMessage('Dilnoza Karim🔥ova', '5001', 10, 10, 27, 30);
    check('29 matnda kun soni bor', matn.includes('10 KUN TUGADI'));
    check('30 natija ko\'rsatilgan', matn.includes('27/30') && matn.includes('90%'));
    check('31 odam teglangan', matn.includes('tg://user?id=5001'));
    check('32 emojili ism matnni buzmaydi',
        Buffer.from(matn, 'utf8').toString('utf8') === matn);
    check('33 motivatsion gap qo\'shilgan', matn.includes('<i>') && matn.length > 120);

    const matn40 = buildMessage('Bek', '2', 40, 10, 30, 30);
    check('34 40-kunda boshqa gap chiqadi', !matn40.includes(matn.split('<i>')[1] ?? 'xxx'));

    // ---------- Takroriy tabrik bo'lmasin ----------
    const guruh = await db.group.create({
        data: { chatId: '-100111', title: 'Ertalabki', status: 'approved' },
    });
    await db.milestone.create({ data: { memberId: dilnoza.id, groupId: guruh.id, day: 10 } });
    let ikkinchi = false;
    try {
        await db.milestone.create({ data: { memberId: dilnoza.id, groupId: guruh.id, day: 10 } });
    } catch {
        ikkinchi = true;
    }
    check('35 bir bosqich ikki marta yozilmaydi', ikkinchi);
    check('36 keyingi bosqich yozilaveradi',
        !!(await db.milestone.create({ data: { memberId: dilnoza.id, groupId: guruh.id, day: 20 } })));

    // ---------- Zaxira yangi maydonlarni olib o'tadimi ----------
    const { exportTenant, parseBackup, importTenant } = require('../src/features/backup');
    await db.groupMember.create({ data: { groupId: guruh.id, memberId: dilnoza.id } });
    const zaxira = await exportTenant(tenant);
    const dilnozaZ = zaxira.members.find((m: any) => m.telegramId === '5001');
    check('37 zaxira shaxsiy vaqtlarni oladi',
        dilnozaZ.breakfastTime === '06:30' && dilnozaZ.setupDone === true);
    check('38 zaxira bosqichlarni ham oladi', zaxira.milestones.length === 2);

    await db.member.update({ where: { id: dilnoza.id }, data: { breakfastTime: null, setupDone: false } });
    await db.milestone.deleteMany({});
    const res = await importTenant(tenant, parseBackup(Buffer.from(JSON.stringify(zaxira))), 'merge', '1');
    const tiklangan = await db.member.findUnique({ where: { telegramId: '5001' } });
    check('39 tiklashdan keyin shaxsiy vaqtlar qaytadi',
        tiklangan.breakfastTime === '06:30' && tiklangan.setupDone === true);
    check('40 bosqichlar ham qaytadi — eski tabrik qayta yuborilmaydi',
        (await db.milestone.count()) === 2 && res.milestones === 2);

    console.log(`\nHAMMASI O'TDI (${passed})`);
    await prisma.$disconnect();
    fs.rmSync(dir, { recursive: true, force: true });
    process.exit(0);
}

main().catch(e => {
    console.error(e);
    fs.rmSync(dir, { recursive: true, force: true });
    process.exit(1);
});
