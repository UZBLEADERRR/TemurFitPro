/// Yetkazib berish zanjirining jonli sinovi: haqiqiy SQLite fayllar + soxta Telegram API.
///
/// Ishga tushirish:  npm run test:delivery
///
/// Tarmoqqa chiqmaydi — Telegraf'ning sendMessage/callApi metodlari
/// almashtiriladi. Ma'lumotlar vaqtinchalik papkadagi haqiqiy SQLite
/// fayllarga yoziladi (DATA_DIR npm script'da beriladi).
import assert from 'assert';
import { prisma, tenantDb } from '../src/core/db';
import { registerTenant, getBotByTenant } from '../src/core/registry';
import { deliverToMember } from '../src/features/delivery';
import { explainSendError } from '../src/features/business';
import { enqueue, processOutbox, listFailed } from '../src/features/outbox';
import { encrypt } from '../src/core/crypto';

const BOT_ID = '777000';
const MEMBER_TG = '5085735510';
const GROUP_CHAT = '-1001234567890';
const COACH_TG = '999';

interface Call { kind: string; chatId: string; text: string }
const calls: Call[] = [];
let businessFails = true;
let botDmFails = true;
const coachDms: Call[] = [];

/// Haqiqiy Telegraf instansiyasini reyestrga yuklaymiz, so'ng faqat
/// tarmoqqa chiqadigan ikkita metodni almashtiramiz — qolgan yo'l
/// (registry → delivery → business) o'zgarishsiz sinaladi.
function stubTelegram(tenantId: string) {
    const bot: any = getBotByTenant(tenantId);
    if (!bot) throw new Error('bot reyestrga tushmadi');

    bot.telegram.sendMessage = async (chatId: string, text: string) => {
        if (String(chatId) === GROUP_CHAT) {
            calls.push({ kind: 'group', chatId: String(chatId), text });
            return { message_id: 1 };
        }
        if (String(chatId) === COACH_TG) {
            coachDms.push({ kind: 'coach', chatId: String(chatId), text });
            return { message_id: 2 };
        }
        if (botDmFails) throw new Error("Forbidden: bot can't initiate conversation with a user");
        calls.push({ kind: 'bot', chatId: String(chatId), text });
        return { message_id: 3 };
    };

    bot.telegram.callApi = async (_method: string, p: any) => {
        if (businessFails) throw new Error('Bad Request: BUSINESS_PEER_USAGE_MISSING');
        calls.push({ kind: 'business', chatId: String(p.chat_id), text: p.text });
        return { message_id: 4 };
    };
}

async function main() {
    const tenant = await prisma.tenant.create({
        data: {
            botId: BOT_ID,
            botTokenEnc: encrypt('1:fake'),
            botUsername: 'testbot',
            botTitle: 'Test',
            webhookSecret: 's',
            status: 'active',
            createdByTgId: COACH_TG,
        },
    });
    await registerTenant(tenant, false);
    stubTelegram(tenant.id);

    const db = await tenantDb(BOT_ID);
    const group = await db.group.create({
        data: { chatId: GROUP_CHAT, title: 'Test guruh', isActive: true, status: 'approved' },
    });
    const member = await db.member.create({
        data: { telegramId: MEMBER_TG, name: 'Temur Farxodov', nameLc: 'temur farxodov' },
    });
    await db.groupMember.create({ data: { groupId: group.id, memberId: member.id } });
    await db.businessConnection.create({
        data: {
            connectionId: 'conn1',
            userTgId: COACH_TG,
            userChatId: COACH_TG,
            userName: 'Murabbiy',
            canReply: true,
            isEnabled: true,
        },
    });

    const target = { id: member.id, telegramId: member.telegramId, name: member.name };

    // ---- 1. Business ham, bot DM ham o'tmaydi → guruhda teg ----
    let res = await deliverToMember(db, tenant, target, 'Salom', { coachTgId: COACH_TG });
    assert.equal(res.ok, true, '1: yetkazilishi kerak');
    assert.equal(res.via, 'group', `1: guruh orqali kutilgandi, keldi ${res.via}`);
    assert.equal(res.attempts.length, 3, '1: uchala kanal sinalishi kerak');
    assert.deepEqual(res.attempts.map(a => a.channel), ['business', 'bot', 'group']);
    assert.ok(calls.at(-1)!.text.includes('Temur Farxodov'), '1: guruhda teglanishi kerak');
    console.log('✅ 1  business ❌ → bot ❌ → guruh ✅');

    // ---- 2. fallback: false → yolg'on emas, xato ----
    res = await deliverToMember(db, tenant, target, 'Salom', { coachTgId: COACH_TG, fallback: false });
    assert.equal(res.ok, false, '2: muvaffaqiyatsiz bo\'lishi kerak');
    assert.equal(res.via, null);
    assert.ok(/24 soat/.test(res.error!), `2: sabab tushuntirilishi kerak, keldi: ${res.error}`);
    console.log('✅ 2  fallback=false → rost xato + izoh');

    // ---- 3. Business ishlaganda birinchi urinishda to'xtaydi ----
    businessFails = false;
    res = await deliverToMember(db, tenant, target, 'Salom', { coachTgId: COACH_TG });
    assert.equal(res.ok, true);
    assert.equal(res.via, 'business', '3: murabbiy nomidan ketishi kerak');
    assert.equal(res.attempts.length, 1, '3: zaxira kanallar tegilmasligi kerak');
    console.log('✅ 3  business ✅ → boshqa kanal sinalmaydi');

    // ---- 4. Navbat: hamma kanal yiqilsa status=failed va murabbiyga xabar ----
    businessFails = true;
    botDmFails = true;
    const orphan = await db.member.create({
        data: { telegramId: '4242', name: 'Guruhsiz Odam', nameLc: 'guruhsiz odam' },
    });
    await enqueue(db, {
        memberId: orphan.id,
        chatId: orphan.telegramId,
        text: 'Yetib bormaydigan xabar',
        channel: 'business',
        createdByTgId: COACH_TG,
    });
    for (let i = 0; i < 3; i++) {
        await db.outboundMessage.updateMany({
            where: { status: 'pending' },
            data: { scheduledFor: new Date(Date.now() - 1000) },
        });
        await processOutbox();
    }
    const row = await db.outboundMessage.findFirst({ where: { memberId: orphan.id } });
    assert.equal(row!.status, 'failed_seen', `4: failed_seen kutilgandi, keldi ${row!.status}`);
    assert.equal(row!.attempts, 3, '4: 3 marta urinilishi kerak');
    assert.equal(coachDms.length, 1, '4: murabbiyga bir marta xabar ketishi kerak');
    assert.ok(/Guruhsiz Odam/.test(coachDms[0].text), '4: kim ekani aytilishi kerak');
    assert.ok(/24 soat/.test(coachDms[0].text), '4: sababi aytilishi kerak');
    console.log('✅ 4  hamma kanal ❌ → status=failed_seen + murabbiyga sababli xabar');

    // ---- 5. Navbat muvaffaqiyatli bo'lsa haqiqiy kanal saqlanadi ----
    await enqueue(db, {
        memberId: member.id,
        chatId: member.telegramId,
        text: 'Guruhga tushadi',
        channel: 'business',
        createdByTgId: COACH_TG,
    });
    await db.outboundMessage.updateMany({
        where: { status: 'pending' },
        data: { scheduledFor: new Date(Date.now() - 1000) },
    });
    await processOutbox();
    const ok = await db.outboundMessage.findFirst({
        where: { memberId: member.id, text: 'Guruhga tushadi' },
    });
    assert.equal(ok!.status, 'sent');
    assert.equal(ok!.channel, 'group', `5: haqiqiy kanal saqlanishi kerak, keldi ${ok!.channel}`);
    console.log('✅ 5  navbat: haqiqatan ishlagan kanal yoziladi');

    // ---- 6. Yetib bormaganlar ro'yxati sababi bilan ----
    const failedList = await listFailed(db);
    assert.equal(failedList.length, 1);
    assert.ok(/24 soat/.test(failedList[0].reason));
    console.log('✅ 6  listFailed sababni ko\'rsatadi');

    // ---- 7. Xato izohlari ----
    assert.ok(/24 soat/.test(explainSendError('Bad Request: BUSINESS_PEER_USAGE_MISSING')));
    assert.ok(/bloklagan|boshlamagan/.test(explainSendError('Forbidden: bot was blocked by the user')));
    assert.equal(explainSendError('qandaydir yangi xato'), 'qandaydir yangi xato');
    console.log('✅ 7  explainSendError');

    console.log('\nHAMMASI O\'TDI');
}

main()
    .catch(e => {
        console.error('❌ SINOV YIQILDI:', e.message);
        process.exit(1);
    })
    .finally(() => prisma.$disconnect());
