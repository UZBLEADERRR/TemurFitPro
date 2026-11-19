/// Jadvalga kim tushadi va hashtagsiz rasm qabul qilinadimi.
///
/// Ikkita xato:
///  1) Guruh kartasi "A'zolar: 1" deb turardi, jadval esa "Hali a'zolar
///     yo'q" derdi — chunki jadval bot egasini chiqarib tashlardi, sanoq
///     esa sanardi. Egasining ovqati "qabul qilindi" deb yozilgan bo'lsa
///     ham jadvalda ko'rinmasdi.
///  2) Hashtagsiz rasm umuman qabul qilinmasdi.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tfp-rec-'));
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
const { renderTable } = require('../src/features/table');
const { GROUP_PARTICIPANT } = require('../src/core/groups');
const { mealByTime, detectMealType } = require('../src/core/meals');

let passed = 0;
function check(name: string, cond: boolean, detail = ''): void {
    if (!cond) {
        console.error(`❌ ${name}${detail ? `\n   ${detail}` : ''}`);
        process.exit(1);
    }
    passed++;
    console.log(`✅ ${name}`);
}

const BOT_ID = '777008';

async function main() {
    const tenant = await prisma.tenant.create({
        data: {
            botId: BOT_ID, botUsername: 'rec_bot', botUsernameLc: 'rec_bot',
            botTokenEnc: encrypt(`${BOT_ID}:AAtest`), webhookSecret: 's', createdByTgId: '1',
            breakfastTime: '08:00', lunchTime: '13:00', dinnerTime: '19:00',
        },
    });
    const db = await tenantDb(BOT_ID);
    const g = await db.group.create({ data: { chatId: '-100111', title: '50Kun', status: 'approved' } });

    // Temur — bot EGASI, lekin guruhga ovqat yuborgan
    const temur = await db.member.create({
        data: { telegramId: '1', name: 'Temur Trans', nameLc: 'temur trans', role: 'owner' },
    });
    await db.groupMember.create({ data: { groupId: g.id, memberId: temur.id } });
    await db.mealRecord.create({
        data: { memberId: temur.id, groupId: g.id, date: new Date().toISOString().slice(0, 10),
                mealType: 'nonushta', timeSent: new Date(), status: 'late' },
    });

    // ---------- Sanoq va jadval bir xil bo'lsin ----------
    const sanoq = await db.groupMember.count({ where: { groupId: g.id, ...GROUP_PARTICIPANT } });
    const jadval = await renderTable(db, tenant, g);

    check("1  ovqat yuborgan ega jadvalda KO'RINADI", jadval.includes('Temur'), jadval.slice(0, 200));
    check("2  jadval 'a'zolar yo'q' demaydi", !jadval.includes("Hali a'zolar yo'q"));
    check('3  sanoq ham 1 ta', sanoq === 1, String(sanoq));

    // ---------- Guruh murabbiysi esa sanalmaydi ----------
    const murabbiy = await db.member.create({ data: { telegramId: '2', name: 'Nazoratchi', nameLc: 'nazoratchi' } });
    await db.groupMember.create({ data: { groupId: g.id, memberId: murabbiy.id, role: 'coach' } });

    const sanoq2 = await db.groupMember.count({ where: { groupId: g.id, ...GROUP_PARTICIPANT } });
    const jadval2 = await renderTable(db, tenant, g);
    check('4  guruh murabbiysi jadvalda yo‘q', !jadval2.includes('Nazoratchi'));
    check('5  u sanoqqa ham kirmaydi', sanoq2 === 1, String(sanoq2));
    check('6  sanoq va jadval HAR DOIM bir xil', sanoq2 === (jadval2.match(/Temur/g) || []).length);

    // ---------- Vaqt bo'yicha ovqat turi ----------
    const m = { breakfastTime: null, lunchTime: null, dinnerTime: null };
    check('7  09:00 → nonushta', mealByTime(tenant, m, 9 * 60) === 'nonushta');
    check('8  14:00 → tushlik', mealByTime(tenant, m, 14 * 60) === 'tushlik');
    check('9  20:00 → kechki', mealByTime(tenant, m, 20 * 60) === 'kechki');
    check('10 06:00 (nonushtadan oldin) → kechki, kechagi kunga yoziladi',
        mealByTime(tenant, m, 6 * 60) === 'kechki');
    check('11 01:00 (yarim tundan keyin) → kechki', mealByTime(tenant, m, 60) === 'kechki');

    // Shaxsiy vaqtlar hisobga olinadi
    const koreys = { breakfastTime: '06:30', lunchTime: '11:30', dinnerTime: '17:30' };
    check('12 koreys uchun 09:00 → nonushta', mealByTime(tenant, koreys, 9 * 60) === 'nonushta');
    check('13 koreys uchun 12:00 → tushlik (umumiy vaqtda esa nonushta bo‘lardi)',
        mealByTime(tenant, koreys, 12 * 60) === 'tushlik' && mealByTime(tenant, m, 12 * 60) === 'nonushta');
    check('14 koreys uchun 18:00 → kechki', mealByTime(tenant, koreys, 18 * 60) === 'kechki');

    // ---------- Hashtag baribir ustun turadi ----------
    check('15 hashtag yozilgan bo‘lsa o‘sha olinadi',
        detectMealType(tenant, 'bugungi #kechki ovqatim') === 'kechki');
    check('16 hashtagsiz matndan hech narsa topilmaydi',
        detectMealType(tenant, 'salom qanday ahvol') === null);

    // ---------- Sozlama ----------
    check('17 standart holatda hashtag majburiy', tenant.requireHashtag === true);
    const off = await prisma.tenant.update({ where: { id: tenant.id }, data: { requireHashtag: false } });
    check('18 sozlamani o‘chirsa bo‘ladi', off.requireHashtag === false);

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
