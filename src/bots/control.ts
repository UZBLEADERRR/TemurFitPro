import { Telegraf, Markup } from 'telegraf';
import type { Context } from 'telegraf';
import type { Tenant } from '@prisma/client';
import { prisma } from '../core/db';
import { env } from '../core/env';
import { log } from '../core/logger';
import { esc, chunkText, downloadFile, tgError } from '../core/telegram';
import {
    createTenant, deleteTenant, pauseTenant, resumeTenant, purgeTenantData,
    addGroup, isSuperAdmin, audit, TenantError, PurgeScope,
} from '../core/tenants';
import { getEntry, webhookUrl } from '../core/registry';
import { ask, aiAvailable } from '../ai/agent';
import { getState, setState, clearState } from './session';
import { formatIn, safeTz } from '../core/time';

// ONA BOT — platformaning boshqaruv markazi.
// Faqat shu botning tokeni Railway env'da turadi; qolgan barcha mijoz botlari
// shu bot orqali qo'shiladi va bazada shifrlangan holda saqlanadi.

const SCOPE = 'control';

export const controlBot = new Telegraf(env.CONTROL_BOT_TOKEN, { handlerTimeout: 90_000 });

controlBot.catch((err, ctx) => {
    log.error('control-bot', `xato (update ${ctx?.update?.update_id ?? '?'})`, err);
});

// ---------- Kirish nazorati ----------
controlBot.use(async (ctx, next) => {
    if (!ctx.from) return;
    if (ctx.chat?.type !== 'private') return; // ona bot faqat shaxsiy chatda ishlaydi
    if (!(await isSuperAdmin(String(ctx.from.id)))) {
        if ((ctx as any).message || (ctx as any).callbackQuery) {
            await ctx
                .reply(
                    `⛔️ Bu bot faqat platforma adminlari uchun.\n\nSizning ID: <code>${ctx.from.id}</code>`,
                    { parse_mode: 'HTML' },
                )
                .catch(() => undefined);
        }
        return;
    }
    return next();
});

// ---------- Menyular ----------
function mainMenu() {
    return Markup.inlineKeyboard([
        [Markup.button.callback("➕ Yangi bot qo'shish", 's:addbot')],
        [Markup.button.callback('🤖 Botlar', 's:bots'), Markup.button.callback('📊 Umumiy holat', 's:overview')],
        [Markup.button.callback('👑 Super adminlar', 's:admins')],
        [Markup.button.callback('🧠 AI bilan boshqarish', 's:ai')],
    ]);
}

function tenantMenu(t: Tenant) {
    const toggle = t.status === 'active'
        ? Markup.button.callback('⏸ Toʻxtatish', `s:pause:${t.id}`)
        : Markup.button.callback('▶️ Ishga tushirish', `s:resume:${t.id}`);
    return Markup.inlineKeyboard([
        [Markup.button.callback('👥 Guruhlar', `s:groups:${t.id}`), Markup.button.callback("🎯 Murabbiylar", `s:coaches:${t.id}`)],
        [Markup.button.callback('📊 Statistika', `s:tstat:${t.id}`), Markup.button.callback('🔑 Gemini kalit', `s:gkey:${t.id}`)],
        [toggle, Markup.button.callback("🗑 Ma'lumot o'chirish", `s:purge:${t.id}`)],
        [Markup.button.callback("❌ Botni butunlay o'chirish", `s:del:${t.id}`)],
        [Markup.button.callback('⬅️ Botlar', 's:bots')],
    ]);
}

function purgeMenu(id: string) {
    return Markup.inlineKeyboard([
        [Markup.button.callback('🍽 Ovqat tarixi', `s:pg:${id}:meals`)],
        [Markup.button.callback("👥 A'zolar", `s:pg:${id}:members`)],
        [Markup.button.callback('🔔 Eslatmalar', `s:pg:${id}:mentions`)],
        [Markup.button.callback('🧠 AI suhbatlar', `s:pg:${id}:ai`)],
        [Markup.button.callback('📭 Navbatdagi xabarlar', `s:pg:${id}:outbox`)],
        [Markup.button.callback('💣 HAMMASI', `s:pg:${id}:all`)],
        [Markup.button.callback('⬅️ Orqaga', `s:bot:${id}`)],
    ]);
}

// ---------- /start ----------
controlBot.start(async ctx => {
    const me = await controlBot.telegram.getMe();
    await reply(
        ctx,
        [
            `👑 <b>TemurFitPro — boshqaruv markazi</b>`,
            `<i>@${me.username}</i>`,
            '',
            "Bu yerdan barcha mijoz botlarini boshqarasiz: yangi bot qo'shish, guruhlar,",
            "murabbiylar, ma'lumotlarni tozalash.",
            '',
            `Sizning ID: <code>${ctx.from.id}</code>`,
        ].join('\n'),
        mainMenu(),
    );
});

controlBot.command('menu', async ctx => reply(ctx, '👑 <b>Boshqaruv markazi</b>', mainMenu()));

controlBot.command('addbot', async ctx => {
    const arg = ctx.message.text.split(/\s+/)[1];
    if (arg) return doAddBot(ctx, arg);
    await setState(SCOPE, String(ctx.chat.id), 'await:token');
    await reply(ctx, askTokenText());
});

controlBot.command('id', async ctx => {
    await ctx.reply(`<code>${ctx.chat.id}</code>`, { parse_mode: 'HTML' });
});

// ---------- Tugmalar ----------
controlBot.on('callback_query', async ctx => {
    const data = (ctx.callbackQuery as any).data as string | undefined;
    if (!data) return;
    await ctx.answerCbQuery().catch(() => undefined);
    const [, action, id, extra] = data.split(':');

    try {
        switch (action) {
            case 'menu':
                return reply(ctx, '👑 <b>Boshqaruv markazi</b>', mainMenu());

            case 'addbot':
                await setState(SCOPE, String(ctx.chat!.id), 'await:token');
                return reply(ctx, askTokenText());

            case 'bots':
                return showBots(ctx);

            case 'bot':
                return showTenant(ctx, id);

            case 'overview':
                return showOverview(ctx);

            case 'admins':
                return showAdmins(ctx);

            case 'addadmin':
                await setState(SCOPE, String(ctx.chat!.id), 'await:adminId');
                return reply(ctx, "👑 Yangi super adminning Telegram ID raqamini yuboring.\n\n<i>ID ni bilish uchun u shu botga yozsin — bot ID sini ko'rsatadi.</i>", back('s:admins'));

            case 'rmadmin': {
                if (String(ctx.from.id) === id) {
                    return reply(ctx, "❌ O'zingizni o'chira olmaysiz.", back('s:admins'));
                }
                await prisma.superAdmin.deleteMany({ where: { telegramId: id } });
                return showAdmins(ctx);
            }

            case 'groups':
                return showGroups(ctx, id);

            case 'addgroup':
                await setState(SCOPE, String(ctx.chat!.id), 'await:groupId', { tenantId: id });
                return reply(
                    ctx,
                    [
                        '👥 <b>Guruh qo\'shish</b>',
                        '',
                        'Guruh chat ID sini yuboring (masalan <code>-1001234567890</code>).',
                        '',
                        "<i>Oson yo'l: botni guruhga qo'shsangiz, u o'zi ro'yxatga olinadi.</i>",
                    ].join('\n'),
                    back(`s:groups:${id}`),
                );

            case 'rmgroup': {
                await prisma.group.update({ where: { id: extra }, data: { isActive: false } });
                return showGroups(ctx, id);
            }

            case 'coaches':
                return showCoaches(ctx, id);

            case 'addcoach':
                await setState(SCOPE, String(ctx.chat!.id), 'await:coachId', { tenantId: id });
                return reply(
                    ctx,
                    "🎯 Murabbiy qilmoqchi bo'lgan odamning Telegram ID sini yoki ismini yuboring.\n\n<i>U avval o'sha botga /start bosgan bo'lishi kerak.</i>",
                    back(`s:coaches:${id}`),
                );

            case 'rmcoach': {
                await prisma.member.update({ where: { id: extra }, data: { role: 'member' } });
                return showCoaches(ctx, id);
            }

            case 'tstat':
                return showTenantStats(ctx, id);

            case 'gkey':
                await setState(SCOPE, String(ctx.chat!.id), 'await:gkey', { tenantId: id });
                return reply(
                    ctx,
                    "🔑 Shu bot uchun alohida Gemini API kalitini yuboring.\n\n<i>Bo'sh qoldirmoqchi bo'lsangiz — <code>-</code> yuboring, global kalit ishlatiladi.</i>",
                    back(`s:bot:${id}`),
                );

            case 'pause': {
                const t = await pauseTenant(id, String(ctx.from.id));
                await reply(ctx, `⏸ @${esc(t.botUsername)} to'xtatildi.`);
                return showTenant(ctx, id);
            }

            case 'resume': {
                const t = await resumeTenant(id, String(ctx.from.id));
                await reply(ctx, `▶️ @${esc(t.botUsername)} qayta ishga tushdi.`);
                return showTenant(ctx, id);
            }

            case 'purge':
                return reply(
                    ctx,
                    "🗑 <b>Nimani o'chiramiz?</b>\n\n<i>Bu amalni qaytarib bo'lmaydi.</i>",
                    purgeMenu(id),
                );

            case 'pg': {
                const scope = extra as PurgeScope;
                await setState(SCOPE, String(ctx.chat!.id), 'idle');
                return reply(
                    ctx,
                    `⚠️ <b>Tasdiqlang</b>\n\n<code>${scope}</code> ma'lumotlari butunlay o'chiriladi.`,
                    Markup.inlineKeyboard([
                        [Markup.button.callback("✅ Ha, o'chir", `s:pgok:${id}:${scope}`)],
                        [Markup.button.callback('❌ Bekor', `s:bot:${id}`)],
                    ]),
                );
            }

            case 'pgok': {
                const summary = await purgeTenantData(id, extra as PurgeScope, String(ctx.from.id));
                return reply(ctx, `🗑 O'chirildi: ${esc(summary)}`, back(`s:bot:${id}`));
            }

            case 'del':
                return reply(
                    ctx,
                    "☠️ <b>Botni butunlay o'chirish</b>\n\nBot, uning guruhlari, a'zolari va butun tarixi o'chadi. Qaytarib bo'lmaydi!",
                    Markup.inlineKeyboard([
                        [Markup.button.callback("✅ Ha, o'chirilsin", `s:delok:${id}`)],
                        [Markup.button.callback('❌ Bekor', `s:bot:${id}`)],
                    ]),
                );

            case 'delok': {
                const username = await deleteTenant(id, String(ctx.from.id));
                await reply(ctx, `❌ @${esc(username)} o'chirildi.`);
                return showBots(ctx);
            }

            case 'ai':
                return showAiPicker(ctx);

            case 'aisel': {
                await setState(SCOPE, String(ctx.chat!.id), 'ai', { tenantId: id });
                const t = await prisma.tenant.findUnique({ where: { id } });
                return reply(
                    ctx,
                    [
                        `🧠 <b>AI rejimi: @${esc(t?.botUsername ?? '')}</b>`,
                        '',
                        'Endi yozgan yoki aytgan har bir gapingiz AI ga boradi.',
                        'Masalan: <i>"3 kunda ovqat yubormaganlarni top va ogohlantirish yubor"</i>',
                        '',
                        'Chiqish uchun /menu bosing.',
                    ].join('\n'),
                    back('s:menu', '⬅️ Chiqish'),
                );
            }
        }
    } catch (e) {
        log.error('control-bot', `callback xatosi (${data})`, e);
        await reply(ctx, `⚠️ Xatolik: ${esc(e instanceof Error ? e.message : String(e))}`);
    }
});

// ---------- Matn / ovoz ----------
controlBot.on(['voice', 'audio'], async ctx => {
    const session = await getState(SCOPE, String(ctx.chat.id));
    if (session.state !== 'ai') {
        return reply(ctx, "🎙 Ovozli buyruq uchun avval <b>🧠 AI bilan boshqarish</b> bo'limidan botni tanlang.", mainMenu());
    }
    const tenant = await prisma.tenant.findUnique({ where: { id: String(session.payload.tenantId) } });
    if (!tenant) return reply(ctx, 'Bot topilmadi.', mainMenu());

    const file = (ctx.message as any).voice ?? (ctx.message as any).audio;
    await ctx.sendChatAction('typing').catch(() => undefined);
    try {
        const buffer = await downloadFile(controlBot, file.file_id);
        const res = await ask({
            tenant,
            actorTgId: String(ctx.from.id),
            actorName: ctx.from.first_name || 'Admin',
            role: 'super',
            audio: { buffer, mimeType: file.mime_type || 'audio/ogg' },
        });
        await reply(ctx, (res.transcript ? `🎙 <i>${esc(res.transcript)}</i>\n\n` : '') + res.reply);
    } catch (e) {
        log.error('control-bot', 'ovoz xatosi', e);
        await reply(ctx, '🎙 Ovozni qayta ishlab bo\'lmadi.');
    }
});

controlBot.on('text', async ctx => {
    const text = ctx.message.text.trim();
    if (text.startsWith('/')) return;

    const chatId = String(ctx.chat.id);
    const session = await getState(SCOPE, chatId);

    switch (session.state) {
        case 'await:token':
            await clearState(SCOPE, chatId);
            return doAddBot(ctx, text);

        case 'await:adminId': {
            await clearState(SCOPE, chatId);
            const tgId = text.replace(/\D/g, '');
            if (!tgId) return reply(ctx, '❌ ID faqat raqamlardan iborat.', back('s:admins'));
            await prisma.superAdmin.upsert({
                where: { telegramId: tgId },
                create: { telegramId: tgId, addedByTgId: String(ctx.from.id) },
                update: {},
            });
            await audit(null, String(ctx.from.id), 'admin.add', tgId);
            return showAdmins(ctx);
        }

        case 'await:groupId': {
            const tenantId = String(session.payload.tenantId);
            await clearState(SCOPE, chatId);
            try {
                const res = await addGroup(tenantId, text);
                await reply(ctx, res.created ? '✅ Guruh qo\'shildi.' : "ℹ️ Bu guruh allaqachon ro'yxatda.");
            } catch (e) {
                await reply(ctx, `❌ ${esc(e instanceof Error ? e.message : String(e))}`);
            }
            return showGroups(ctx, tenantId);
        }

        case 'await:coachId': {
            const tenantId = String(session.payload.tenantId);
            await clearState(SCOPE, chatId);
            const member = await prisma.member.findFirst({
                where: {
                    tenantId,
                    OR: [{ telegramId: text.replace(/\D/g, '') }, { name: { contains: text, mode: 'insensitive' } }],
                },
            });
            if (!member) {
                await reply(ctx, "❌ Bunday a'zo topilmadi. U avval o'sha botga /start bosishi kerak.");
                return showCoaches(ctx, tenantId);
            }
            await prisma.member.update({ where: { id: member.id }, data: { role: 'coach' } });
            await audit(tenantId, String(ctx.from.id), 'coach.add', member.name);
            await reply(ctx, `🎯 <b>${esc(member.name)}</b> murabbiy qilib tayinlandi.`);
            return showCoaches(ctx, tenantId);
        }

        case 'await:gkey': {
            const tenantId = String(session.payload.tenantId);
            await clearState(SCOPE, chatId);
            const { encrypt } = await import('../core/crypto');
            await prisma.tenant.update({
                where: { id: tenantId },
                data: { geminiKeyEnc: text === '-' ? null : encrypt(text) },
            });
            await reply(ctx, text === '-' ? '🔑 Global kalitga qaytarildi.' : '🔑 Kalit saqlandi.');
            return showTenant(ctx, tenantId);
        }

        case 'ai': {
            const tenant = await prisma.tenant.findUnique({ where: { id: String(session.payload.tenantId) } });
            if (!tenant) return reply(ctx, 'Bot topilmadi.', mainMenu());
            if (!aiAvailable(tenant)) return reply(ctx, "🤖 AI sozlanmagan — GEMINI_API_KEY kerak.", mainMenu());
            await ctx.sendChatAction('typing').catch(() => undefined);
            const res = await ask({
                tenant,
                actorTgId: String(ctx.from.id),
                actorName: ctx.from.first_name || 'Admin',
                role: 'super',
                text,
            });
            return reply(ctx, res.reply);
        }

        default:
            return reply(ctx, "Menyudan tanlang 👇", mainMenu());
    }
});

// ---------- Ko'rinishlar ----------

async function doAddBot(ctx: Context, token: string) {
    try {
        const tenant = await createTenant(token, String(ctx.from!.id));
        const hookNote = env.PUBLIC_URL
            ? `Webhook: <code>${esc(webhookUrl(tenant))}</code>`
            : "⚠️ <b>PUBLIC_URL sozlanmagan</b> — webhook o'rnatilmadi. Railway'da PUBLIC_URL ni qo'shing.";
        await reply(
            ctx,
            [
                `✅ <b>Bot qo'shildi!</b>`,
                '',
                `🤖 @${esc(tenant.botUsername)}`,
                `🆔 <code>${tenant.botId}</code>`,
                '',
                hookNote,
                '',
                "Endi botni guruhlarga qo'shing — ular avtomatik ro'yxatga olinadi.",
                "Murabbiy o'sha botga /start bossin, keyin uni bu yerdan murabbiy qilib belgilang.",
            ].join('\n'),
            tenantMenu(tenant),
        );
    } catch (e) {
        const msg = e instanceof TenantError ? e.message : `Kutilmagan xato: ${esc(String(e))}`;
        await reply(ctx, `❌ ${msg}`, back('s:menu'));
    }
}

async function showBots(ctx: Context) {
    const tenants = await prisma.tenant.findMany({ orderBy: { createdAt: 'asc' } });
    if (tenants.length === 0) {
        return reply(ctx, "🤖 Hali bot qo'shilmagan.", Markup.inlineKeyboard([
            [Markup.button.callback("➕ Birinchi botni qo'shish", 's:addbot')],
            [Markup.button.callback('⬅️ Menyu', 's:menu')],
        ]));
    }
    const rows = tenants.map(t => {
        const live = getEntry(t.botId) ? '🟢' : t.status === 'paused' ? '⏸' : '🔴';
        return [Markup.button.callback(`${live} @${t.botUsername}`, `s:bot:${t.id}`)];
    });
    rows.push([Markup.button.callback("➕ Yangi bot", 's:addbot'), Markup.button.callback('⬅️ Menyu', 's:menu')]);
    return reply(ctx, `🤖 <b>Botlar (${tenants.length})</b>\n\n🟢 ishlayapti · ⏸ to'xtatilgan · 🔴 yuklanmagan`, Markup.inlineKeyboard(rows));
}

async function showTenant(ctx: Context, tenantId: string) {
    const t = await prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!t) return reply(ctx, 'Bot topilmadi.', back('s:bots'));

    const [groups, members, coaches, meals, pending] = await Promise.all([
        prisma.group.count({ where: { tenantId, isActive: true } }),
        prisma.member.count({ where: { tenantId, status: 'active' } }),
        prisma.member.count({ where: { tenantId, role: { in: ['coach', 'owner'] } } }),
        prisma.mealRecord.count({ where: { tenantId } }),
        prisma.outboundMessage.count({ where: { tenantId, status: 'pending' } }),
    ]);
    const live = getEntry(t.botId) ? '🟢 ishlayapti' : t.status === 'paused' ? "⏸ to'xtatilgan" : '🔴 yuklanmagan';

    return reply(
        ctx,
        [
            `🤖 <b>@${esc(t.botUsername)}</b>`,
            `${live}`,
            '',
            `👥 Guruhlar: <b>${groups}</b>`,
            `🧑 A'zolar: <b>${members}</b> (murabbiy: ${coaches})`,
            `🍽 Ovqat qaydlari: <b>${meals}</b>`,
            `📭 Navbatdagi xabarlar: <b>${pending}</b>`,
            `🧠 AI ismi: <b>${esc(t.agentName)}</b>`,
            `🔑 Gemini kalit: ${t.geminiKeyEnc ? 'alohida' : 'global'}`,
            `🌍 ${t.timezone}`,
            `📅 Qo'shilgan: ${formatIn(t.createdAt, safeTz(t.timezone), 'dd.MM.yyyy')}`,
        ].join('\n'),
        tenantMenu(t),
    );
}

async function showGroups(ctx: Context, tenantId: string) {
    const groups = await prisma.group.findMany({ where: { tenantId, isActive: true }, orderBy: { createdAt: 'asc' } });
    const rows = await Promise.all(
        groups.map(async g => {
            const n = await prisma.groupMember.count({ where: { groupId: g.id } });
            return [Markup.button.callback(`🗑 ${(g.title || g.chatId).slice(0, 28)} (${n})`, `s:rmgroup:${tenantId}:${g.id}`)];
        }),
    );
    rows.push([Markup.button.callback("➕ Guruh qo'shish", `s:addgroup:${tenantId}`)]);
    rows.push([Markup.button.callback('⬅️ Orqaga', `s:bot:${tenantId}`)]);

    return reply(
        ctx,
        groups.length
            ? `👥 <b>Guruhlar (${groups.length})</b>\n\n<i>Guruh nomiga bosilsa — ro'yxatdan chiqariladi.</i>`
            : "👥 Hali guruh yo'q.\n\n<i>Botni guruhga qo'shsangiz avtomatik ro'yxatga olinadi.</i>",
        Markup.inlineKeyboard(rows),
    );
}

async function showCoaches(ctx: Context, tenantId: string) {
    const coaches = await prisma.member.findMany({
        where: { tenantId, role: { in: ['coach', 'owner'] } },
        orderBy: { joinedAt: 'asc' },
    });
    const rows = coaches.map(c => [
        Markup.button.callback(`${c.role === 'owner' ? '👑' : '🎯'} ${c.name}${c.role === 'owner' ? '' : ' ✕'}`,
            c.role === 'owner' ? `s:coaches:${tenantId}` : `s:rmcoach:${tenantId}:${c.id}`),
    ]);
    rows.push([Markup.button.callback('➕ Murabbiy qo\'shish', `s:addcoach:${tenantId}`)]);
    rows.push([Markup.button.callback('⬅️ Orqaga', `s:bot:${tenantId}`)]);

    return reply(
        ctx,
        coaches.length
            ? `🎯 <b>Murabbiylar (${coaches.length})</b>\n\n👑 ega · 🎯 murabbiy\n<i>Nomga bosilsa murabbiylik olinadi.</i>`
            : "🎯 Hali murabbiy tayinlanmagan.",
        Markup.inlineKeyboard(rows),
    );
}

async function showTenantStats(ctx: Context, tenantId: string) {
    const t = await prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!t) return;
    const { getStats, formatStats } = await import('../features/filters');
    const res = await getStats(t, { days: 7 });
    return reply(ctx, formatStats(res), back(`s:bot:${tenantId}`));
}

async function showOverview(ctx: Context) {
    const [tenants, active, members, meals, groups, pending, failed] = await Promise.all([
        prisma.tenant.count(),
        prisma.tenant.count({ where: { status: 'active' } }),
        prisma.member.count({ where: { status: 'active' } }),
        prisma.mealRecord.count(),
        prisma.group.count({ where: { isActive: true } }),
        prisma.outboundMessage.count({ where: { status: 'pending' } }),
        prisma.outboundMessage.count({ where: { status: 'failed' } }),
    ]);
    const today = await prisma.mealRecord.count({
        where: { timeSent: { gte: new Date(Date.now() - 24 * 3600_000) } },
    });

    return reply(
        ctx,
        [
            '📊 <b>Platforma holati</b>',
            '',
            `🤖 Botlar: <b>${active}/${tenants}</b> faol`,
            `👥 Guruhlar: <b>${groups}</b>`,
            `🧑 A'zolar: <b>${members}</b>`,
            `🍽 Jami ovqat qaydi: <b>${meals}</b>`,
            `📈 Oxirgi 24 soatda: <b>${today}</b>`,
            `📭 Navbatda: <b>${pending}</b> · ❌ xato: <b>${failed}</b>`,
            '',
            `🧠 Gemini: ${env.GEMINI_API_KEY ? `✅ ${env.GEMINI_MODEL}` : '❌ sozlanmagan'}`,
            `🌐 PUBLIC_URL: ${env.PUBLIC_URL ? '✅' : '❌ sozlanmagan'}`,
        ].join('\n'),
        back('s:menu'),
    );
}

async function showAdmins(ctx: Context) {
    const admins = await prisma.superAdmin.findMany({ orderBy: { createdAt: 'asc' } });
    const rows = admins.map(a => [
        Markup.button.callback(
            `${String(ctx.from!.id) === a.telegramId ? '👤' : '👑'} ${a.name || a.telegramId}${String(ctx.from!.id) === a.telegramId ? ' (siz)' : ' ✕'}`,
            String(ctx.from!.id) === a.telegramId ? 's:admins' : `s:rmadmin:${a.telegramId}`,
        ),
    ]);
    rows.push([Markup.button.callback('➕ Admin qo\'shish', 's:addadmin')]);
    rows.push([Markup.button.callback('⬅️ Menyu', 's:menu')]);
    return reply(ctx, `👑 <b>Super adminlar (${admins.length})</b>`, Markup.inlineKeyboard(rows));
}

async function showAiPicker(ctx: Context) {
    const tenants = await prisma.tenant.findMany({ where: { status: 'active' }, orderBy: { createdAt: 'asc' } });
    if (!tenants.length) return reply(ctx, "Avval bot qo'shing.", back('s:menu'));
    const rows = tenants.map(t => [Markup.button.callback(`@${t.botUsername}`, `s:aisel:${t.id}`)]);
    rows.push([Markup.button.callback('⬅️ Menyu', 's:menu')]);
    return reply(ctx, '🧠 <b>Qaysi botni boshqaramiz?</b>\n\nTanlang, keyin oddiy tilda buyruq bering.', Markup.inlineKeyboard(rows));
}

// ---------- utils ----------
function back(action: string, label = '⬅️ Orqaga') {
    return Markup.inlineKeyboard([[Markup.button.callback(label, action)]]);
}

function askTokenText() {
    return [
        "➕ <b>Yangi bot qo'shish</b>",
        '',
        '1. @BotFather ga o\'ting va <code>/newbot</code> bilan bot yarating',
        '2. Olingan <b>tokenni</b> shu yerga tashlang',
        '',
        '<i>Namuna: 123456789:AAHdqTcvbXXXXXXXXXXXXXXXXXXXX</i>',
    ].join('\n');
}

async function reply(ctx: Context, text: string, keyboard?: any): Promise<void> {
    const chunks = chunkText(text);
    for (let i = 0; i < chunks.length; i++) {
        const isLast = i === chunks.length - 1;
        await ctx
            .reply(chunks[i], {
                parse_mode: 'HTML',
                link_preview_options: { is_disabled: true },
                ...(isLast && keyboard ? keyboard : {}),
            } as any)
            .catch(async e => {
                log.warn('control-bot', `HTML xatosi: ${tgError(e)}`);
                await ctx.reply(chunks[i].replace(/<[^>]+>/g, '')).catch(() => undefined);
            });
    }
}

/// Env'dagi super adminlarni bazaga seed qilish
export async function seedSuperAdmins(): Promise<void> {
    for (const id of env.SUPER_ADMIN_IDS) {
        await prisma.superAdmin.upsert({
            where: { telegramId: id },
            create: { telegramId: id, name: 'env' },
            update: {},
        });
    }
    const count = await prisma.superAdmin.count();
    log.info('control-bot', `${count} ta super admin`);
    if (count === 0) {
        log.warn('control-bot', "SUPER_ADMIN_IDS bo'sh — ona botga hech kim kira olmaydi!");
    }
}
