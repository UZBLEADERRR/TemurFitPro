/// Guruhga nima ketadi va ma'lumot deployda saqlanadimi.
///
/// Talab: "Bot faqat qabul qilinganini aytsin va eslatsin. Har 10 kunda
/// guruhga tabrik jo'natsa yetadi. Keraksiz har bir xabarni pin
/// qilavermasin. Ishlamaydigan link bor xabar ham kelyapti."

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tfp-q-'));
fs.mkdirSync(path.join(dir, 'tenants'), { recursive: true });
const root = path.join(__dirname, '..');

execFileSync(
    'npx',
    ['prisma', 'db', 'push', '--schema', 'prisma/platform.prisma', '--skip-generate'],
    { env: { ...process.env, PLATFORM_DATABASE_URL: `file:${path.join(dir, 'platform.db')}` }, cwd: root, stdio: 'ignore' },
);

process.env.DATA_DIR = dir;
process.env.CONTROL_BOT_TOKEN = '1:test';
delete process.env.RAILWAY_VOLUME_MOUNT_PATH;

const { prisma, tenantDb } = require('../src/core/db');
const { encrypt } = require('../src/core/crypto');
const { renderTable } = require('../src/features/table');
const { resolveDataDir } = require('./data-dir.cjs');

let passed = 0;
function check(name: string, cond: boolean, detail = ''): void {
    if (!cond) {
        console.error(`❌ ${name}${detail ? `\n   ${detail}` : ''}`);
        process.exit(1);
    }
    passed++;
    console.log(`✅ ${name}`);
}

/// Bezak emoji (ism ichidagisi hisobga olinmaydi — u foydalanuvchi ma'lumoti)
const DECOR = /[\u{1F300}-\u{1FAFF}\u{2B00}-\u{2BFF}\u{2600}-\u{27BF}]/u;

const BOT_ID = '777009';

async function main() {
    const tenant = await prisma.tenant.create({
        data: {
            botId: BOT_ID, botUsername: 'q_bot', botUsernameLc: 'q_bot',
            botTokenEnc: encrypt(`${BOT_ID}:AAtest`), webhookSecret: 's', createdByTgId: '1',
        },
    });
    const db = await tenantDb(BOT_ID);
    const g = await db.group.create({ data: { chatId: '-100111', title: '50Kun', status: 'approved' } });

    const bek = await db.member.create({ data: { telegramId: '1', name: 'Bek', nameLc: 'bek' } });
    await db.groupMember.create({ data: { groupId: g.id, memberId: bek.id } });
    const bugun = new Date().toISOString().slice(0, 10);
    await db.mealRecord.create({
        data: { memberId: bek.id, groupId: g.id, date: bugun, mealType: 'nonushta',
                timeSent: new Date(), status: 'on_time' },
    });

    // ---------- Jadval ----------
    const jadval = await renderTable(db, tenant, g);
    check('1  jadvalda bezak emoji yo‘q', !DECOR.test(jadval), jadval.slice(0, 160));
    check('2  jadval ishni bajaradi — ism bor', jadval.includes('Bek'));
    check('3  belgilar bir xil kenglikda', jadval.includes('+') && jadval.includes('·'));

    // Ustunlar tekis turadimi — emojili ism bilan ham
    const emojili = await db.member.create({ data: { telegramId: '2', name: 'Jasur 🔥', nameLc: 'jasur' } });
    await db.groupMember.create({ data: { groupId: g.id, memberId: emojili.id } });
    const jadval2 = await renderTable(db, tenant, g);
    const qatorlar = jadval2.split('\n').filter((l: string) => l.includes('<code>') && /\d+\./.test(l));
    const kengliklar = qatorlar.map((l: string) => {
        const m = /<code>(.*?)<\/code>/.exec(l);
        return m ? Array.from(m[1]).length : 0;
    });
    check('4  emojili ism ustunni buzmaydi', new Set(kengliklar).size === 1, JSON.stringify(kengliklar));

    // ---------- Ishlamaydigan link ----------
    const src = fs.readFileSync(path.join(root, 'src/features/table.ts'), 'utf8');
    check('5  guruh jadvalida inline tugma yo‘q',
        !src.includes('inline_keyboard') && !src.includes('reply_markup'),
        src.split('\n').filter(l => l.includes('inline_keyboard') || l.includes('reply_markup')).join(' | '));
    check('6  mini ilova havolasi guruhga ketmaydi', !src.includes('webappUrl'));

    // ---------- Pin: faqat yangi xabar yaratilganda ----------
    const sched = fs.readFileSync(path.join(root, 'src/scheduler.ts'), 'utf8');
    check('7  kunlik jadval eski pinni yechmaydi', !sched.includes('unpinChatMessage'));
    check('8  kunlik jadval yangi xabar yaratmaydi', !sched.includes('createAndPinTable'));
    check('9  kunlik jadval mavjudini tahrirlaydi', sched.includes('updateGroupTable(db, tenant, group)'));
    const pinlar = (src.match(/pinChatMessage/g) || []).length;
    check('10 pin faqat bitta joyda — xabar yaratilganda', pinlar === 1, `${pinlar} ta`);

    // ---------- Guruhga ketadigan matnlar ----------
    const rec = fs.readFileSync(path.join(root, 'src/features/recording.ts'), 'utf8');
    const javob = /const mark = .*?;/s.exec(rec)?.[0] ?? '';
    check('11 "qabul qilindi" javobi bezaksiz', !DECOR.test(javob), javob);

    const eslatma = /const text =\s*`\$\{mention[\s\S]*?;/.exec(sched)?.[0] ?? '';
    check('12 eslatma bezaksiz', !DECOR.test(eslatma), eslatma.slice(0, 120));
    check('13 eslatma baqirmaydi (undov belgisi yo‘q)', !eslatma.includes('!`') && !eslatma.includes('!<'));

    // ---------- Ma'lumot joyi ----------
    // Testda DATA_DIR qo'yilgan — lokal zaxira yo'lini tekshirish uchun olib turamiz
    const withoutEnv = (fn: () => string | null) => {
        const old = { ...process.env };
        delete process.env.DATA_DIR;
        delete process.env.RAILWAY_VOLUME_MOUNT_PATH;
        delete process.env.RAILWAY_ENVIRONMENT;
        try { return fn(); } finally { process.env = old; }
    };
    check('14 lokalda ./data ishlatiladi',
        (withoutEnv(() => resolveDataDir()) ?? '').endsWith('/data'),
        String(withoutEnv(() => resolveDataDir())));

    const xato = (() => {
        const old = { ...process.env };
        delete process.env.DATA_DIR;
        delete process.env.RAILWAY_VOLUME_MOUNT_PATH;
        process.env.RAILWAY_ENVIRONMENT = 'production';
        try { resolveDataDir(); return null; }
        catch (e) { return (e as Error).message; }
        finally { process.env = old; }
    })();
    check('15 Railway‘da Volume‘siz ISHGA TUSHMAYDI', !!xato, String(xato));
    check('16 xato sababini va yechimini aytadi',
        !!xato && xato.includes('Volume') && xato.includes('/data'), String(xato).slice(0, 80));

    const pre = fs.readFileSync(path.join(root, 'scripts/prestart.js'), 'utf8');
    check('17 prestart ham o‘sha moduldan oladi', pre.includes("require('./data-dir.cjs')"));
    // Izohlarda eslatilishi mumkin — buyruqning O'ZIDA bo'lmasligi kerak
    const buyruq = pre.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    check('18 --accept-data-loss buyruqdan olib tashlangan',
        !buyruq.includes('--accept-data-loss'),
        buyruq.split('\n').filter(l => l.includes('db')).join(' | ').slice(0, 120));

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
