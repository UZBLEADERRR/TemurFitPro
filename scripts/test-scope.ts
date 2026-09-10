/// Har guruhga alohida murabbiy: kim nimani ko'radi.
///
/// Asosiy va'da: "Ertalabki guruh" murabbiysi "Kechki guruh"ning
/// a'zolarini, statistikasini va jadvalini KO'RMASLIGI kerak.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tfp-sc-'));
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
const { scopeFor, allowsGroup, coachGroupIds } = require('../src/core/scope');
const { listGroups, listMembers, getStats, findMissingToday, searchMembers } = require('../src/features/filters');

let passed = 0;
function check(name: string, cond: boolean, detail = ''): void {
    if (!cond) {
        console.error(`❌ ${name}${detail ? `\n   ${detail}` : ''}`);
        process.exit(1);
    }
    passed++;
    console.log(`✅ ${name}`);
}

const BOT_ID = '777002';

async function main() {
    const tenant = await prisma.tenant.create({
        data: {
            botId: BOT_ID, botUsername: 'scope_bot', botUsernameLc: 'scope_bot',
            botTokenEnc: encrypt(`${BOT_ID}:AAtest`), webhookSecret: 's', createdByTgId: '1',
        },
    });
    const db = await tenantDb(BOT_ID);

    const ertalab = await db.group.create({ data: { chatId: '-100111', title: 'Ertalabki', status: 'approved' } });
    const kechki = await db.group.create({ data: { chatId: '-100222', title: 'Kechki', status: 'approved' } });

    // Aziz — faqat Ertalabki guruh murabbiysi
    const aziz = await db.member.create({ data: { telegramId: '1', name: 'Aziz', nameLc: 'aziz' } });
    // Bek — faqat Kechki guruh murabbiysi
    const bek = await db.member.create({ data: { telegramId: '2', name: 'Bek', nameLc: 'bek' } });
    // Temur — global murabbiy (hammasini ko'radi)
    const temur = await db.member.create({ data: { telegramId: '3', name: 'Temur', nameLc: 'temur', role: 'coach' } });
    // Oddiy a'zolar
    const dilnoza = await db.member.create({ data: { telegramId: '10', name: 'Dilnoza', nameLc: 'dilnoza' } });
    const jasur = await db.member.create({ data: { telegramId: '11', name: 'Jasur', nameLc: 'jasur' } });

    await db.groupMember.create({ data: { groupId: ertalab.id, memberId: aziz.id, role: 'coach' } });
    await db.groupMember.create({ data: { groupId: kechki.id, memberId: bek.id, role: 'coach' } });
    await db.groupMember.create({ data: { groupId: ertalab.id, memberId: dilnoza.id } });
    await db.groupMember.create({ data: { groupId: kechki.id, memberId: jasur.id } });

    // ---------- Doiralar ----------
    const sAziz = await scopeFor(db, aziz, false);
    const sBek = await scopeFor(db, bek, false);
    const sTemur = await scopeFor(db, temur, false);
    const sDilnoza = await scopeFor(db, dilnoza, false);
    const sSuper = await scopeFor(db, null, true);

    check('1  guruh murabbiysi — murabbiy hisoblanadi', sAziz.isManager && sAziz.isGroupCoach);
    check('2  guruh murabbiysining doirasi faqat o\'z guruhi',
        sAziz.groupIds?.length === 1 && sAziz.groupIds[0] === ertalab.id);
    check('3  global murabbiy cheklanmagan', sTemur.isManager && sTemur.groupIds === null && !sTemur.isGroupCoach);
    check('4  super admin cheklanmagan', sSuper.isManager && sSuper.groupIds === null);
    check('5  oddiy a\'zo murabbiy emas', !sDilnoza.isManager && sDilnoza.groupIds?.length === 0);

    check('6  Aziz o\'z guruhiga ruxsatli', allowsGroup(sAziz, ertalab.id));
    check('7  Aziz BOSHQA guruhga ruxsatsiz', !allowsGroup(sAziz, kechki.id));
    check('8  Bek ham faqat o\'zinikiga', allowsGroup(sBek, kechki.id) && !allowsGroup(sBek, ertalab.id));
    check('9  global murabbiy ikkalasiga ham', allowsGroup(sTemur, ertalab.id) && allowsGroup(sTemur, kechki.id));
    check('10 oddiy a\'zo hech qaysisiga', !allowsGroup(sDilnoza, ertalab.id));

    // ---------- Guruhlar ro'yxati ----------
    const gAziz = await listGroups(db, sAziz.groupIds);
    const gTemur = await listGroups(db, sTemur.groupIds);
    check('11 Aziz faqat bitta guruh ko\'radi', gAziz.length === 1 && gAziz[0].title === 'Ertalabki');
    check('12 global murabbiy ikkalasini ko\'radi', gTemur.length === 2);

    // ---------- A'zolar ----------
    const mAziz = await listMembers(db, { allowedGroupIds: sAziz.groupIds });
    const mBek = await listMembers(db, { allowedGroupIds: sBek.groupIds });
    const mTemur = await listMembers(db, { allowedGroupIds: sTemur.groupIds });

    check('13 Aziz faqat o\'z guruhining a\'zolarini ko\'radi',
        mAziz.every((m: any) => m.name !== 'Jasur') && mAziz.some((m: any) => m.name === 'Dilnoza'),
        mAziz.map((m: any) => m.name).join(','));
    check('14 Bek faqat o\'zinikini',
        mBek.every((m: any) => m.name !== 'Dilnoza') && mBek.some((m: any) => m.name === 'Jasur'),
        mBek.map((m: any) => m.name).join(','));
    check('15 global murabbiy ikkalasini ham',
        mTemur.some((m: any) => m.name === 'Dilnoza') && mTemur.some((m: any) => m.name === 'Jasur'));

    // ---------- Statistika ----------
    const stAziz = await getStats(db, tenant, { days: 7, allowedGroupIds: sAziz.groupIds });
    check('16 statistikaga ham boshqa guruh tushmaydi',
        stAziz.rows.every((r: any) => r.name !== 'Jasur'),
        stAziz.rows.map((r: any) => r.name).join(','));

    // ---------- Bugun yubormaganlar ----------
    const missAziz = await findMissingToday(db, { allowedGroupIds: sAziz.groupIds });
    check('17 "yubormaganlar" ham cheklangan', missAziz.every((r: any) => r.name !== 'Jasur'));

    // ---------- Qidiruv ----------
    const qidir = await searchMembers(db, 'jasur', sAziz.groupIds);
    check('18 qidiruv orqali ham boshqa guruh a\'zosi topilmaydi', qidir.length === 0,
        qidir.map((m: any) => m.name).join(','));
    const qidirTemur = await searchMembers(db, 'jasur', sTemur.groupIds);
    check('19 global murabbiy uni topa oladi', qidirTemur.length === 1);

    // ---------- Murabbiylikni olib tashlash ----------
    await db.groupMember.update({
        where: { groupId_memberId: { groupId: ertalab.id, memberId: aziz.id } },
        data: { role: 'member' },
    });
    const sAziz2 = await scopeFor(db, aziz, false);
    check('20 murabbiylik olinsa doira yopiladi', !sAziz2.isManager && sAziz2.groupIds?.length === 0);

    // ---------- Ikki guruhga birdan murabbiy ----------
    await db.groupMember.create({ data: { groupId: kechki.id, memberId: aziz.id, role: 'coach' } });
    await db.groupMember.update({
        where: { groupId_memberId: { groupId: ertalab.id, memberId: aziz.id } },
        data: { role: 'coach' },
    });
    const sAziz3 = await scopeFor(db, aziz, false);
    check('21 bir odam bir necha guruhga murabbiy bo\'la oladi', sAziz3.groupIds?.length === 2);

    // ---------- Tasdiqlanmagan guruh doiraga kirmasin ----------
    const kutayotgan = await db.group.create({
        data: { chatId: '-100333', title: 'Yangi', status: 'pending' },
    });
    await db.groupMember.create({ data: { groupId: kutayotgan.id, memberId: bek.id, role: 'coach' } });
    const ids = await coachGroupIds(db, bek.id);
    check('22 tasdiqlanmagan guruh murabbiy doirasiga kirmaydi',
        !ids.includes(kutayotgan.id) && ids.includes(kechki.id), ids.join(','));

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
