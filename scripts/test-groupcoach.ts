/// Guruh murabbiysini tayinlash.
///
/// Xato: bot bir nechta guruhda bo'lsa, murabbiyni IKKINCHI guruhga
/// tayinlab bo'lmasdi. Sababi — ro'yxat faqat GroupMember qatori bor
/// odamlardan tuzilardi, u qator esa odam guruhga RASM YUBORGANDA
/// yaratiladi. /start bosgan murabbiyda u qator yo'q edi.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tfp-gc-'));
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
const { scopeFor } = require('../src/core/scope');
const { renderTable } = require('../src/features/table');

let passed = 0;
function check(name: string, cond: boolean, detail = ''): void {
    if (!cond) {
        console.error(`❌ ${name}${detail ? `\n   ${detail}` : ''}`);
        process.exit(1);
    }
    passed++;
    console.log(`✅ ${name}`);
}

const BOT_ID = '777006';

/// Ona botdagi "ismga bosish" amali — control.ts dagi gcoachset bilan bir xil
async function toggleCoach(db: any, groupId: string, memberId: string) {
    const link = await db.groupMember.findUnique({ where: { groupId_memberId: { groupId, memberId } } });
    if (link?.role === 'coach') {
        const meals = await db.mealRecord.count({ where: { memberId, groupId } });
        if (meals === 0) await db.groupMember.delete({ where: { groupId_memberId: { groupId, memberId } } });
        else await db.groupMember.update({ where: { groupId_memberId: { groupId, memberId } }, data: { role: 'member' } });
    } else {
        await db.groupMember.upsert({
            where: { groupId_memberId: { groupId, memberId } },
            create: { groupId, memberId, role: 'coach' },
            update: { role: 'coach' },
        });
    }
}

async function main() {
    const tenant = await prisma.tenant.create({
        data: {
            botId: BOT_ID, botUsername: 'gc_bot', botUsernameLc: 'gc_bot',
            botTokenEnc: encrypt(`${BOT_ID}:AAtest`), webhookSecret: 's', createdByTgId: '1',
        },
    });
    const db = await tenantDb(BOT_ID);

    const g1 = await db.group.create({ data: { chatId: '-100111', title: '40Kun', status: 'approved' } });
    const g2 = await db.group.create({ data: { chatId: '-100222', title: '50Kun', status: 'approved' } });

    // Temur /start bosgan — Member qatori bor, lekin hech qaysi guruhga
    // rasm yubormagan, ya'ni GroupMember qatori YO'Q
    const temur = await db.member.create({ data: { telegramId: '100', name: 'Temur', nameLc: 'temur' } });
    // Oddiy a'zo 1-guruhga rasm yuborgan
    const azo = await db.member.create({ data: { telegramId: '200', name: 'Dilnoza', nameLc: 'dilnoza' } });
    await db.groupMember.create({ data: { groupId: g1.id, memberId: azo.id } });

    check('1  xato sharoiti: murabbiyda guruh qatori yo\'q',
        (await db.groupMember.count({ where: { memberId: temur.id } })) === 0);

    // ---------- 1-guruhga tayinlash ----------
    await toggleCoach(db, g1.id, temur.id);
    const l1 = await db.groupMember.findUnique({ where: { groupId_memberId: { groupId: g1.id, memberId: temur.id } } });
    check('2  rasm yubormagan odam ham murabbiy qilinadi', l1?.role === 'coach');

    // ---------- IKKINCHI guruhga tayinlash (asosiy xato) ----------
    await toggleCoach(db, g2.id, temur.id);
    const l2 = await db.groupMember.findUnique({ where: { groupId_memberId: { groupId: g2.id, memberId: temur.id } } });
    check('3  IKKINCHI guruhga ham tayinlanadi', l2?.role === 'coach', JSON.stringify(l2));

    check('4  ikkala guruhda ham murabbiy',
        (await db.groupMember.count({ where: { memberId: temur.id, role: 'coach' } })) === 2);

    const sc = await scopeFor(db, temur, false);
    check('5  doirasiga ikkala guruh kirdi', sc.groupIds?.length === 2, JSON.stringify(sc.groupIds));

    // ---------- Jadvalda ishtirokchi bo'lib ko'rinmasin ----------
    const jadval = await renderTable(db, tenant, g1);
    check('6  murabbiy jadvalda ishtirokchi emas', !jadval.includes('Temur'), jadval.slice(0, 200));
    check('7  oddiy a\'zo jadvalda bor', jadval.includes('Dilnoza'));

    // ---------- Murabbiylikni olib tashlash ----------
    await toggleCoach(db, g2.id, temur.id);
    check('8  murabbiylik olindi va qator ham ketdi (guruhga hech narsa yubormagan)',
        !(await db.groupMember.findUnique({ where: { groupId_memberId: { groupId: g2.id, memberId: temur.id } } })));
    check('9  1-guruhdagi murabbiyligi saqlandi',
        (await db.groupMember.count({ where: { memberId: temur.id, role: 'coach' } })) === 1);

    // ---------- Haqiqiy a'zoni murabbiy qilib, keyin qaytarish ----------
    await db.mealRecord.create({
        data: { memberId: azo.id, groupId: g1.id, date: '2026-11-19', mealType: 'nonushta',
                timeSent: new Date(), status: 'on_time' },
    });
    await toggleCoach(db, g1.id, azo.id);
    check('10 guruh a\'zosi murabbiy qilindi',
        (await db.groupMember.findUnique({ where: { groupId_memberId: { groupId: g1.id, memberId: azo.id } } }))?.role === 'coach');

    await toggleCoach(db, g1.id, azo.id);
    const back = await db.groupMember.findUnique({ where: { groupId_memberId: { groupId: g1.id, memberId: azo.id } } });
    check('11 ovqat tarixi bor a\'zo guruhdan CHIQARILMAYDI, a\'zolikka qaytadi',
        back?.role === 'member', JSON.stringify(back));
    check('12 uning ovqat qaydi joyida', (await db.mealRecord.count({ where: { memberId: azo.id } })) === 1);

    // ---------- Bot darajasidagi murabbiy (hamma guruh uchun) ----------
    // Temur "hamma guruhning murabbiysi" bo'lsa — guruh bo'yicha tayinlash
    // kerak emas, Member.role = coach/owner yetadi.
    await db.groupMember.deleteMany({ where: { memberId: temur.id } });
    await db.member.update({ where: { id: temur.id }, data: { role: 'owner' } });

    const scGlobal = await scopeFor(db, await db.member.findUnique({ where: { id: temur.id } }), false);
    check('13 bot murabbiysi BARCHA guruhni ko\'radi (cheklovsiz)',
        scGlobal.isManager && scGlobal.groupIds === null, JSON.stringify(scGlobal));

    // Bot murabbiysi guruhga OVQAT YUBORSA — u ishtirokchi, jadvalda
    // ko'rinishi SHART. Aks holda bot "qabul qilindi" deb javob beradi-yu,
    // jadval "Hali a'zolar yo'q" deb turadi.
    await db.groupMember.create({ data: { groupId: g1.id, memberId: temur.id } });
    await db.mealRecord.create({
        data: { memberId: temur.id, groupId: g1.id, date: '2026-11-19', mealType: 'tushlik',
                timeSent: new Date(), status: 'on_time' },
    });
    const jadval2 = await renderTable(db, tenant, g1);
    check('14 ovqat yuborgan bot murabbiysi jadvalda KO\'RINADI',
        jadval2.includes('Temur'), jadval2.slice(0, 250));
    check('15 oddiy a\'zo esa joyida', jadval2.includes('Dilnoza'));

    // Lekin GURUH murabbiysi (boshqaruv uchun qo'shilgan) ko'rinmaydi
    await db.groupMember.update({
        where: { groupId_memberId: { groupId: g1.id, memberId: temur.id } },
        data: { role: 'coach' },
    });
    const jadval3 = await renderTable(db, tenant, g1);
    check('16 guruh murabbiysi esa jadvalda yo\'q', !jadval3.includes('Temur'), jadval3.slice(0, 250));

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
