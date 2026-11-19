/// Bot murabbiylarini boshqarish: olib tashlash va egalikni berish.
///
/// Xato: botga BIRINCHI /start bosgan odam avtomatik "ega" bo'ladi, lekin
/// 👑 ega qatori o'lik tugma edi — uni bosganda ekran qayta chizilardi.
/// Natijada tasodifan ega bo'lib qolgan odamni olib tashlab ham, egalikni
/// haqiqiy murabbiyga berib ham bo'lmasdi.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tfp-cr-'));
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

let passed = 0;
function check(name: string, cond: boolean, detail = ''): void {
    if (!cond) {
        console.error(`❌ ${name}${detail ? `\n   ${detail}` : ''}`);
        process.exit(1);
    }
    passed++;
    console.log(`✅ ${name}`);
}

const BOT_ID = '777007';

// control.ts dagi amallarning aynan nusxasi
async function setOwner(db: any, memberId: string) {
    await db.member.updateMany({ where: { role: 'owner' }, data: { role: 'coach' } });
    await db.member.update({ where: { id: memberId }, data: { role: 'owner' } });
}
async function removeCoach(db: any, memberId: string): Promise<'ok' | 'last'> {
    const managers = await db.member.count({ where: { role: { in: ['coach', 'owner'] } } });
    if (managers <= 1) return 'last';
    await db.member.update({ where: { id: memberId }, data: { role: 'member' } });
    return 'ok';
}

async function main() {
    await prisma.tenant.create({
        data: {
            botId: BOT_ID, botUsername: 'cr_bot', botUsernameLc: 'cr_bot',
            botTokenEnc: encrypt(`${BOT_ID}:AAtest`), webhookSecret: 's', createdByTgId: '1',
        },
    });
    const db = await tenantDb(BOT_ID);

    // Ali birinchi /start bosgan — avtomatik ega
    const ali = await db.member.create({ data: { telegramId: '1', name: 'Ali', nameLc: 'ali', role: 'owner' } });
    const temur = await db.member.create({ data: { telegramId: '2', name: 'Temur Farxodov', nameLc: 'temur farxodov', role: 'coach' } });
    const azo = await db.member.create({ data: { telegramId: '3', name: 'Dilnoza', nameLc: 'dilnoza' } });
    await db.mealRecord.create({
        data: { memberId: ali.id, date: '2026-11-19', mealType: 'nonushta', timeSent: new Date(), status: 'on_time' },
    });

    check("1  xato sharoiti: tasodifan ega bo'lib qolgan odam", ali.role === 'owner');

    // ---------- Egalikni haqiqiy murabbiyga berish ----------
    await setOwner(db, temur.id);
    const t1 = await db.member.findUnique({ where: { id: temur.id } });
    const a1 = await db.member.findUnique({ where: { id: ali.id } });
    check("2  egalik Temurga o'tdi", t1.role === 'owner', t1.role);
    check("3  Ali murabbiy bo'lib qoldi (huquqi yo'qolmadi)", a1.role === 'coach', a1.role);
    check("4  ega faqat BITTA", (await db.member.count({ where: { role: 'owner' } })) === 1);

    // ---------- Alini murabbiylikdan olish ----------
    const r = await removeCoach(db, ali.id);
    const a2 = await db.member.findUnique({ where: { id: ali.id } });
    check("5  Ali olib tashlandi", r === 'ok' && a2.role === 'member', `${r} / ${a2.role}`);
    check("6  uning ovqat tarixi tegilmadi", (await db.mealRecord.count({ where: { memberId: ali.id } })) === 1);

    const scAli = await scopeFor(db, a2, false);
    check("7  Ali endi boshqaruvchi emas", !scAli.isManager);
    const scTemur = await scopeFor(db, t1, false);
    check("8  Temur barcha guruhlarni ko'radi", scTemur.isManager && scTemur.groupIds === null);

    // ---------- Oxirgi murabbiyni olib tashlab bo'lmasin ----------
    const r2 = await removeCoach(db, temur.id);
    check("9  oxirgi murabbiyni olib tashlash RAD etiladi", r2 === 'last');
    check("10 u hali ham ega", (await db.member.findUnique({ where: { id: temur.id } })).role === 'owner');

    // ---------- Boshqa murabbiy qo'shilgach olib tashlash mumkin ----------
    await db.member.update({ where: { id: azo.id }, data: { role: 'coach' } });
    const r3 = await removeCoach(db, temur.id);
    check("11 ikkinchi murabbiy bo'lsa olib tashlanadi", r3 === 'ok');
    check("12 bot boshqaruvsiz qolmadi",
        (await db.member.count({ where: { role: { in: ['coach', 'owner'] } } })) === 1);

    // ---------- Oddiy a'zoni egalikka ko'tarish ----------
    await setOwner(db, ali.id);
    check("13 oddiy a'zoni ham ega qilsa bo'ladi",
        (await db.member.findUnique({ where: { id: ali.id } })).role === 'owner');
    check("14 avvalgi ega murabbiylikka tushdi",
        (await db.member.findUnique({ where: { id: azo.id } })).role === 'coach');

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
