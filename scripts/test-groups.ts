/// Guruh qo'shish va ro'yxatdan o'chirish.
///
/// Sabab: foydalanuvchining ro'yxatida 3 ta "o'lik" qator qolib ketgan edi —
/// minusi tushib qolgan ID bilan qo'shilgan, o'chirish tugmasi esa yo'q edi.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tfp-gr-'));
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
const { addGroup, purgeGroupData, TenantError } = require('../src/core/tenants');

let passed = 0;
function check(name: string, cond: boolean, detail = ''): void {
    if (!cond) {
        console.error(`❌ ${name}${detail ? `\n   ${detail}` : ''}`);
        process.exit(1);
    }
    passed++;
    console.log(`✅ ${name}`);
}

const BOT_ID = '777005';

async function main() {
    const tenant = await prisma.tenant.create({
        data: {
            botId: BOT_ID, botUsername: 'gr_bot', botUsernameLc: 'gr_bot',
            botTokenEnc: encrypt(`${BOT_ID}:AAtest`), webhookSecret: 's', createdByTgId: '1',
        },
    });
    const db = await tenantDb(BOT_ID);

    // ---------- Noto'g'ri ID ----------
    const rad = async (id: string) => {
        try { await addGroup(tenant, id); return null; }
        catch (e) { return e instanceof TenantError ? (e as Error).message : 'boshqa xato'; }
    };

    const m1 = await rad('5055318069');
    check('1  minussiz ID rad etiladi', !!m1, String(m1));
    check('2  xato xabari to\'g\'ri variantni taklif qiladi',
        !!m1 && m1.includes('-1005055318069'), String(m1));
    check('3  xato xabari /id ni eslatadi', !!m1 && m1.includes('/id'));
    check('4  harf aralashgan ID rad etiladi', !!(await rad('abc123')));
    check('5  bo\'sh qiymat rad etiladi', !!(await rad('')));
    check('6  bazada chiqindi qator qolmadi', (await db.group.count()) === 0);

    // ---------- To'g'ri ID ----------
    const ok = await addGroup(tenant, '-1005055318069', '50Kun Transformatsiya');
    check('7  to\'g\'ri ID qabul qilinadi', ok.created === true);
    const g = await db.group.findUnique({ where: { chatId: '-1005055318069' } });
    check('8  darrov tasdiqlangan holatda qo\'shiladi',
        g.status === 'approved' && g.isActive === true);

    // ---------- Ma'lumot bilan guruhni o'chirish ----------
    const a1 = await db.member.create({ data: { telegramId: '1', name: 'A', nameLc: 'a' } });
    const a2 = await db.member.create({ data: { telegramId: '2', name: 'B', nameLc: 'b' } });
    const boshqa = await addGroup(tenant, '-100999', 'Boshqa guruh');

    await db.groupMember.create({ data: { groupId: g.id, memberId: a1.id } });
    await db.groupMember.create({ data: { groupId: g.id, memberId: a2.id } });
    // a2 ikkala guruhda ham
    await db.groupMember.create({ data: { groupId: boshqa.id, memberId: a2.id } });
    await db.mealRecord.create({
        data: { memberId: a1.id, groupId: g.id, date: '2026-11-19', mealType: 'nonushta',
                timeSent: new Date(), status: 'on_time' },
    });

    check('9  o\'chirishdan oldin 2 guruh bor', (await db.group.count()) === 2);

    await purgeGroupData(tenant, g.id, '1', true);

    check('10 guruh ro\'yxatdan ketdi',
        !(await db.group.findUnique({ where: { chatId: '-1005055318069' } })));
    check('11 ikkinchi guruh joyida', !!(await db.group.findUnique({ where: { chatId: '-100999' } })));
    check('12 ovqat qaydlari ham ketdi', (await db.mealRecord.count()) === 0);
    check('13 faqat shu guruhdagi a\'zo o\'chdi',
        !(await db.member.findUnique({ where: { telegramId: '1' } })));
    check('14 ikkala guruhda turgan a\'zo SAQLANDI',
        !!(await db.member.findUnique({ where: { telegramId: '2' } })));

    // ---------- Bo'sh guruhni o'chirish ----------
    const bosh = await addGroup(tenant, '-100777', '');
    await purgeGroupData(tenant, bosh.id, '1', true);
    check('15 bo\'sh guruh ham o\'chadi', (await db.group.count()) === 1);

    // ---------- Tozalash (o'chirmasdan) ----------
    const tirik = await db.group.findUnique({ where: { chatId: '-100999' } });
    await purgeGroupData(tenant, tirik.id, '1', false);
    check('16 "tozalash" guruhni ro\'yxatda QOLDIRADI',
        !!(await db.group.findUnique({ where: { chatId: '-100999' } })));

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
