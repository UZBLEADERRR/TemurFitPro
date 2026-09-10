/// Zaxira → yo'qotish → tiklash yo'lini boshdan-oxir tekshiradi.
///
/// Asosiy va'da: "guruhning datasi ochib ketsa, faylni botga tashlasam
/// tiklanishi kerak". Shu yerda aynan shu stsenariy o'ynaladi.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tfp-bk-'));
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

// Import DATA_DIR o'rnatilgandan KEYIN bo'lishi shart
const { prisma, tenantDb } = require('../src/core/db');
const { encrypt } = require('../src/core/crypto');
const { exportTenant, exportTenantFile, parseBackup, importTenant } = require('../src/features/backup');

let passed = 0;
function check(name: string, cond: boolean, detail = ''): void {
    if (!cond) {
        console.error(`❌ ${name}${detail ? `\n   ${detail}` : ''}`);
        process.exit(1);
    }
    passed++;
    console.log(`✅ ${name}`);
}

const BOT_ID = '777001';

async function main() {
    // ---------- Boshlang'ich holat ----------
    const tenant = await prisma.tenant.create({
        data: {
            botId: BOT_ID,
            botUsername: 'sinov_bot',
            botUsernameLc: 'sinov_bot',
            botTokenEnc: encrypt(`${BOT_ID}:AAtest`),
            webhookSecret: 'sirsir',
            createdByTgId: '1',
            breakfastTime: '07:30',
            dinnerWords: 'kechki,#kechki,maxsus',
        },
    });

    const db = await tenantDb(BOT_ID);

    const ertalab = await db.group.create({
        data: { chatId: '-100111', title: 'Ertalabki guruh', status: 'approved' },
    });
    const kechki = await db.group.create({
        data: { chatId: '-100222', title: 'Kechki guruh', status: 'approved' },
    });

    // Ismida emoji bor a'zo — zaxira uni ham buzmasdan olib o'tishi kerak
    const dilnoza = await db.member.create({
        data: { telegramId: '5001', name: 'Dilnoza Karim🔥ova', nameLc: 'dilnoza karim🔥ova', timezone: 'Asia/Seoul' },
    });
    const jasur = await db.member.create({
        data: { telegramId: '5002', name: 'Jasur', nameLc: 'jasur' },
    });
    const murabbiy = await db.member.create({
        data: { telegramId: '5003', name: 'Aziz', nameLc: 'aziz' },
    });

    await db.groupMember.create({ data: { groupId: ertalab.id, memberId: dilnoza.id } });
    await db.groupMember.create({ data: { groupId: ertalab.id, memberId: murabbiy.id, role: 'coach' } });
    await db.groupMember.create({ data: { groupId: kechki.id, memberId: jasur.id } });
    // Dilnoza ikkala guruhda ham
    await db.groupMember.create({ data: { groupId: kechki.id, memberId: dilnoza.id } });

    for (let i = 1; i <= 5; i++) {
        await db.mealRecord.create({
            data: {
                memberId: dilnoza.id, groupId: ertalab.id,
                date: `2026-09-0${i}`, mealType: 'nonushta',
                timeSent: new Date(`2026-09-0${i}T07:00:00Z`), status: 'on_time',
            },
        });
    }
    await db.mealRecord.create({
        data: {
            memberId: jasur.id, groupId: kechki.id,
            date: '2026-09-01', mealType: 'kechki',
            timeSent: new Date('2026-09-01T19:00:00Z'), status: 'late',
        },
    });
    await db.reminderOverride.create({ data: { memberId: jasur.id, mealType: 'tushlik', muted: true } });

    // ---------- 1. Eksport ----------
    const backup = await exportTenant(tenant);
    check('1  zaxirada ikkala guruh ham bor', backup.groups.length === 2);
    check('2  uchala a\'zo ham bor', backup.members.length === 3);
    check('3  guruh a\'zoliklari bor', backup.groupMembers.length === 4);
    check('4  ovqat qaydlari bor', backup.meals.length === 6, `${backup.meals.length}`);
    check('5  guruh murabbiysi roli saqlangan',
        backup.groupMembers.some((l: any) => l.telegramId === '5003' && l.role === 'coach'));
    check('6  bot sozlamalari saqlangan',
        backup.settings.breakfastTime === '07:30' && String(backup.settings.dinnerWords).includes('maxsus'));
    check('7  faylda bot tokeni YO\'Q', !JSON.stringify(backup).includes('AAtest'));

    const file = await exportTenantFile(tenant);
    check('8  fayl nomi va hajmi to\'g\'ri', file.filename.endsWith('.json') && file.buffer.length > 100);
    check('9  fayl qayta o\'qiladi', parseBackup(file.buffer).members.length === 3);

    // ---------- 2. FALOKAT: bitta guruh ma'lumoti yo'qoldi ----------
    await db.mealRecord.deleteMany({ where: { groupId: ertalab.id } });
    await db.groupMember.deleteMany({ where: { groupId: ertalab.id } });
    await db.group.delete({ where: { id: ertalab.id } });
    await db.member.delete({ where: { id: dilnoza.id } });

    check('10 falokat haqiqiy — guruh yo\'q', (await db.group.count()) === 1);
    check('11 falokat haqiqiy — ovqat qaydlari yo\'q', (await db.mealRecord.count()) === 1);

    // ---------- 3. Qo'shib tiklash ----------
    const res = await importTenant(tenant, parseBackup(file.buffer), 'merge', '1');

    check('12 guruh qaytdi', (await db.group.count()) === 2);
    check('13 a\'zo qaytdi', (await db.member.count()) === 3);
    check('14 ovqat qaydlari qaytdi', (await db.mealRecord.count()) === 6, `${await db.mealRecord.count()}`);
    check('15 guruh a\'zoliklari qaytdi', (await db.groupMember.count()) === 4);

    const qaytgan = await db.member.findUnique({ where: { telegramId: '5001' } });
    check('16 emojili ism buzilmagan', qaytgan?.name === 'Dilnoza Karim🔥ova', qaytgan?.name);

    const yangiErtalab = await db.group.findUnique({ where: { chatId: '-100111' } });
    check('17 guruh AYNAN o\'sha chatId bilan qaytdi', !!yangiErtalab);

    const coachLink = await db.groupMember.findFirst({
        where: { groupId: yangiErtalab!.id, memberId: (await db.member.findUnique({ where: { telegramId: '5003' } }))!.id },
    });
    check('18 guruh murabbiysi roli ham qaytdi', coachLink?.role === 'coach', coachLink?.role);

    check('19 tegmagan guruh buzilmadi',
        (await db.mealRecord.count({ where: { group: { chatId: '-100222' } } })) === 1);
    check('20 hisobot to\'g\'ri', res.groups.created === 1 && res.members.created === 1 && res.meals.created === 5,
        JSON.stringify(res));

    // ---------- 4. Qayta tiklash zarar qilmasin (idempotent) ----------
    const res2 = await importTenant(tenant, parseBackup(file.buffer), 'merge', '1');
    check('21 ikkinchi marta tiklash dublikat yaratmaydi',
        (await db.mealRecord.count()) === 6 && (await db.member.count()) === 3);
    check('22 hammasi "allaqachon bor" deb belgilandi', res2.meals.created === 0 && res2.meals.skipped === 6);

    // ---------- 5. Jonli ma'lumot fayldan yangiroq bo'lsa — tegilmasin ----------
    await db.mealRecord.create({
        data: {
            memberId: (await db.member.findUnique({ where: { telegramId: '5002' } }))!.id,
            date: '2026-09-09', mealType: 'nonushta', timeSent: new Date(), status: 'on_time',
        },
    });
    await importTenant(tenant, parseBackup(file.buffer), 'merge', '1');
    check('23 zaxiradan keyin qo\'shilgan yozuv o\'chib ketmaydi',
        (await db.mealRecord.count({ where: { date: '2026-09-09' } })) === 1);

    // ---------- 6. Bot chiqarilgan guruh "faol" bo'lib qolmasin ----------
    await db.group.update({ where: { chatId: '-100222' }, data: { isActive: false } });
    await importTenant(tenant, parseBackup(file.buffer), 'merge', '1');
    const kechkiQayta = await db.group.findUnique({ where: { chatId: '-100222' } });
    check('24 tiklash chiqarilgan guruhni "faol" qilib qo\'ymaydi', kechkiQayta?.isActive === false);

    // ---------- 7. To'liq almashtirish ----------
    const resR = await importTenant(tenant, parseBackup(file.buffer), 'replace', '1');
    check('25 to\'liq almashtirishdan keyin faqat fayldagisi qoladi',
        (await db.mealRecord.count()) === 6 && (await db.member.count()) === 3,
        `${await db.mealRecord.count()} qayd`);
    check('26 keyin qo\'shilgan yozuv endi yo\'q',
        (await db.mealRecord.count({ where: { date: '2026-09-09' } })) === 0);
    check('27 almashtirish hisoboti to\'g\'ri', resR.mode === 'replace' && resR.groups.created === 2);

    // ---------- 8. Yaroqsiz fayllar ----------
    let threw = 0;
    for (const bad of [Buffer.from('salom'), Buffer.from('{"a":1}'), Buffer.from('[]')]) {
        try { parseBackup(bad); } catch { threw++; }
    }
    check('28 yaroqsiz fayl aniq xato bilan rad etiladi', threw === 3, `${threw}/3`);

    // ---------- 9. gzip ----------
    const zlib = require('zlib');
    const gz = zlib.gzipSync(Buffer.from(JSON.stringify(backup)));
    check('29 gzip fayl ham o\'qiladi', parseBackup(gz).members.length === 3);

    // ---------- 10. Sozlamalar tiklandi ----------
    const t2 = await prisma.tenant.findUnique({ where: { id: tenant.id } });
    check('30 bot sozlamalari ham tiklandi',
        t2.breakfastTime === '07:30' && t2.dinnerWords.includes('maxsus'));

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
