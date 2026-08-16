import { Telegraf, Markup } from 'telegraf';
import type { Context } from 'telegraf';
import type { Tenant } from '../generated/platform';
import { prisma, tenantDb, tenantDbSize } from '../core/db';
import { DATA_DIR } from '../core/paths';
import { humanSize, dbSizeBytes, platformDbPath } from '../core/paths';
import { env } from '../core/env';
import { log } from '../core/logger';
import { esc, chunkText, tgError } from '../core/telegram';
import {
    createTenant, deleteTenant, pauseTenant, resumeTenant, purgeTenantData, purgeOlderThan,
    addGroup, isSuperAdmin, audit, TenantError, PurgeScope,
} from '../core/tenants';
import { getEntry, webhookUrl, tenantSpec, reconcileTenantWebhooks } from '../core/registry';
import { getState } from '../core/webhooks';
import { getControlState, setControlState, clearControlState } from './session';
import { formatIn, safeTz, daysAgoIn } from '../core/time';
import { getStats, formatStats, findInactive, formatInactive } from '../features/filters';

// ONA BOT — platformaning boshqaruv markazi.
// Faqat shu botning tokeni env'da; qolgan botlar shu bot orqali qo'shiladi.

export const controlBot = new Telegraf(env.CONTROL_BOT_TOKEN, { handlerTimeout: 90_000 });

controlBot.catch((err, ctx) => {
    log.error('control-bot', `xato (update ${ctx?.update?.update_id ?? '?'})`, err);
});

// ---------- Kirish nazorati ----------
controlBot.use(async (ctx, next) => {
    if (!ctx.from) return;
    if (ctx.chat?.type !== 'private') return;
    if (!(await isSuperAdmin(String(ctx.from.id)))) {
        await ctx
            .reply(`⛔️ Bu bot faqat platforma adminlari uchun.\n\nSizning ID: <code>${ctx.from.id}</code>`, {
                parse_mode: 'HTML',
            })
            .catch(() => undefined);
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
        [
            Markup.button.callback('💾 Disk', 's:disk'),
            Markup.button.callback('🔌 Webhook', 's:hooks'),
        ],
    ]);
}

function tenantMenu(t: Tenant) {
    const toggle =
        t.status === 'active'
            ? Markup.button.callback("⏸ To'xtatish", `s:pause:${t.id}`)
            : Markup.button.callback('▶️ Ishga tushirish', `s:resume:${t.id}`);
    return Markup.inlineKeyboard([
        [
            Markup.button.callback('🏠 Guruhlar', `s:groups:${t.id}`),
            Markup.button.callback('🎯 Murabbiylar', `s:coaches:${t.id}`),
        ],
        [
            Markup.button.callback('⚠️ Yubormaganlar', `s:inactive:${t.id}`),
            Markup.button.callback('📈 Reyting', `s:tstat:${t.id}`),
        ],
        [toggle, Markup.button.callback("🧹 Tozalash", `s:purge:${t.id}`)],
        [Markup.button.callback("❌ Botni butunlay o'chirish", `s:del:${t.id}`)],
        [Markup.button.callback('⬅️ Botlar', 's:bots')],
    ]);
}

function purgeMenu(id: string) {
    return Markup.inlineKeyboard([
        [Markup.button.callback('🍽 Ovqat tarixi', `s:pg:${id}:meals`)],
        [Markup.button.callback("👥 A'zolar", `s:pg:${id}:members`)],
        [Markup.button.callback('🔔 Eslatmalar', `s:pg:${id}:mentions`)],
        [Markup.button.callback('📭 Navbatdagi xabarlar', `s:pg:${id}:outbox`)],
        [Markup.button.callback('🗓 30 kundan eskisi', `s:pgold:${id}:30`)],
        [Markup.button.callback('🗓 90 kundan eskisi', `s:pgold:${id}:90`)],
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
            '👑 <b>TemurFitPro — boshqaruv markazi</b>',
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
    await setControlState(String(ctx.chat.id), 'await:token');
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
                await setControlState(String(ctx.chat!.id), 'await:token');
                return reply(ctx, askTokenText());

            case 'bots':
                return showBots(ctx);

            case 'bot':
                return showTenant(ctx, id);

            case 'overview':
                return showOverview(ctx);

            case 'disk':
                return showDisk(ctx);

            case 'hooks':
                return showWebhooks(ctx);

            case 'fixhooks': {
                const { reconcileControlWebhook } = await import('../index');
                const controlOk = await reconcileControlWebhook();
                const res = await reconcileTenantWebhooks();
                await reply(
                    ctx,
                    `🔄 Ona bot: ${controlOk ? '✅' : '❌'} · Mijoz botlari: ${res.fixed}/${res.checked} tiklandi`,
                );
                return showWebhooks(ctx);
            }

            case 'admins':
                return showAdmins(ctx);

            case 'addadmin':
                await setControlState(String(ctx.chat!.id), 'await:adminId');
                return reply(
                    ctx,
                    "👑 Yangi super adminning Telegram ID raqamini yuboring.\n\n<i>ID ni bilish uchun u shu botga yozsin.</i>",
                    back('s:admins'),
                );

            case 'rmadmin': {
                if (String(ctx.from.id) === id) return reply(ctx, "❌ O'zingizni o'chira olmaysiz.", back('s:admins'));
                await prisma.superAdmin.deleteMany({ where: { telegramId: id } });
                return showAdmins(ctx);
            }

            case 'groups':
                return showGroups(ctx, id);

            case 'addgroup':
                await setControlState(String(ctx.chat!.id), 'await:groupId', { tenantId: id });
                return reply(
                    ctx,
                    [
                        "🏠 <b>Guruh qo'shish</b>",
                        '',
                        'Guruh chat ID sini yuboring (masalan <code>-1001234567890</code>).',
                        '',
                        "<i>Oson yo'l: botni guruhga qo'shsangiz, u o'zi ro'yxatga olinadi.</i>",
                    ].join('\n'),
                    back(`s:groups:${id}`),
                );

            case 'rmgroup': {
                const t = await prisma.tenant.findUnique({ where: { id } });
                if (t) {
                    const db = await tenantDb(t.botId);
                    await db.group.update({ where: { id: extra }, data: { isActive: false } });
                }
                return showGroups(ctx, id);
            }

            case 'coaches':
                return showCoaches(ctx, id);

            case 'addcoach':
                await setControlState(String(ctx.chat!.id), 'await:coachId', { tenantId: id });
                return reply(
                    ctx,
                    "🎯 Murabbiy qilmoqchi bo'lgan odamning Telegram ID sini yoki ismini yuboring.\n\n<i>U avval o'sha botga /start bosgan bo'lishi kerak.</i>",
                    back(`s:coaches:${id}`),
                );

            case 'rmcoach': {
                const t = await prisma.tenant.findUnique({ where: { id } });
                if (t) {
                    const db = await tenantDb(t.botId);
                    await db.member.update({ where: { id: extra }, data: { role: 'member' } });
                }
                return showCoaches(ctx, id);
            }

            case 'tstat': {
                const t = await prisma.tenant.findUnique({ where: { id } });
                if (!t) return;
                const db = await tenantDb(t.botId);
                return reply(ctx, formatStats(await getStats(db, t, { days: 7 })), back(`s:bot:${id}`));
            }

            case 'inactive': {
                const t = await prisma.tenant.findUnique({ where: { id } });
                if (!t) return;
                const db = await tenantDb(t.botId);
                const rows = await findInactive(db, t, { days: 2 });
                const groups = await db.group.count({ where: { isActive: true } });
                return reply(ctx, formatInactive(rows, 2, groups), back(`s:bot:${id}`));
            }

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
                    "🧹 <b>Nimani tozalaymiz?</b>\n\n<i>Bu amalni qaytarib bo'lmaydi. Tozalagandan keyin fayl hajmi ham kichrayadi.</i>",
                    purgeMenu(id),
                );

            case 'pg':
                return reply(
                    ctx,
                    `⚠️ <b>Tasdiqlang</b>\n\n<code>${extra}</code> ma'lumotlari butunlay o'chiriladi.`,
                    Markup.inlineKeyboard([
                        [Markup.button.callback("✅ Ha, o'chir", `s:pgok:${id}:${extra}`)],
                        [Markup.button.callback('❌ Bekor', `s:bot:${id}`)],
                    ]),
                );

            case 'pgok': {
                const t = await prisma.tenant.findUnique({ where: { id } });
                if (!t) return;
                const summary = await purgeTenantData(t, extra as PurgeScope, String(ctx.from.id));
                return reply(ctx, `🧹 O'chirildi: ${esc(summary)}`, back(`s:bot:${id}`));
            }

            case 'pgold': {
                const t = await prisma.tenant.findUnique({ where: { id } });
                if (!t) return;
                const before = daysAgoIn(safeTz(t.timezone), Number(extra));
                const summary = await purgeOlderThan(t, before, String(ctx.from.id));
                return reply(ctx, `🗓 O'chirildi: ${esc(summary)}`, back(`s:bot:${id}`));
            }

            case 'del':
                return reply(
                    ctx,
                    "☠️ <b>Botni butunlay o'chirish</b>\n\nBotning <b>butun ma'lumot fayli</b> o'chadi: guruhlar, a'zolar, tarix. Qaytarib bo'lmaydi!",
                    Markup.inlineKeyboard([
                        [Markup.button.callback("✅ Ha, o'chirilsin", `s:delok:${id}`)],
                        [Markup.button.callback('❌ Bekor', `s:bot:${id}`)],
                    ]),
                );

            case 'delok': {
                const username = await deleteTenant(id, String(ctx.from.id));
                await reply(ctx, `❌ @${esc(username)} va uning ma'lumot fayli o'chirildi.`);
                return showBots(ctx);
            }
        }
    } catch (e) {
        log.error('control-bot', `callback xatosi (${data})`, e);
        await reply(ctx, `⚠️ Xatolik: ${esc(e instanceof Error ? e.message : String(e))}`);
    }
});

// ---------- Matn ----------
controlBot.on('text', async ctx => {
    const text = ctx.message.text.trim();
    if (text.startsWith('/')) return;

    const chatId = String(ctx.chat.id);
    const session = await getControlState(chatId);

    switch (session.state) {
        case 'await:token':
            await clearControlState(chatId);
            return doAddBot(ctx, text);

        case 'await:adminId': {
            await clearControlState(chatId);
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
            await clearControlState(chatId);
            const t = await prisma.tenant.findUnique({ where: { id: tenantId } });
            if (!t) return reply(ctx, 'Bot topilmadi.', mainMenu());
            try {
                const res = await addGroup(t, text);
                await reply(ctx, res.created ? "✅ Guruh qo'shildi." : "ℹ️ Bu guruh allaqachon ro'yxatda.");
            } catch (e) {
                await reply(ctx, `❌ ${esc(e instanceof Error ? e.message : String(e))}`);
            }
            return showGroups(ctx, tenantId);
        }

        case 'await:coachId': {
            const tenantId = String(session.payload.tenantId);
            await clearControlState(chatId);
            const t = await prisma.tenant.findUnique({ where: { id: tenantId } });
            if (!t) return reply(ctx, 'Bot topilmadi.', mainMenu());
            const db = await tenantDb(t.botId);
            const digits = text.replace(/\D/g, '');
            const member =
                (digits && (await db.member.findUnique({ where: { telegramId: digits } }))) ||
                (await db.member.findFirst({ where: { nameLc: { contains: text.toLowerCase() } } }));
            if (!member) {
                await reply(ctx, "❌ Bunday a'zo topilmadi. U avval o'sha botga /start bosishi kerak.");
                return showCoaches(ctx, tenantId);
            }
            await db.member.update({ where: { id: member.id }, data: { role: 'coach' } });
            await audit(tenantId, String(ctx.from.id), 'coach.add', member.name);
            await reply(ctx, `🎯 <b>${esc(member.name)}</b> murabbiy qilib tayinlandi.`);
            return showCoaches(ctx, tenantId);
        }

        default:
            return reply(ctx, 'Menyudan tanlang 👇', mainMenu());
    }
});

// ---------- Ko'rinishlar ----------

async function doAddBot(ctx: Context, token: string) {
    try {
        const tenant = await createTenant(token, String(ctx.from!.id));
        const hookNote = env.PUBLIC_URL
            ? `Webhook: <code>${esc(webhookUrl(tenant))}</code>`
            : "⚠️ <b>PUBLIC_URL sozlanmagan</b> — webhook o'rnatilmadi.";
        await reply(
            ctx,
            [
                "✅ <b>Bot qo'shildi!</b>",
                '',
                `🤖 @${esc(tenant.botUsername)}`,
                `🆔 <code>${tenant.botId}</code>`,
                `💾 Ma'lumot fayli: <code>${tenant.botId}.db</code>`,
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
        return reply(
            ctx,
            "🤖 Hali bot qo'shilmagan.",
            Markup.inlineKeyboard([
                [Markup.button.callback("➕ Birinchi botni qo'shish", 's:addbot')],
                [Markup.button.callback('⬅️ Menyu', 's:menu')],
            ]),
        );
    }
    const rows = tenants.map(t => {
        const live = getEntry(t.botId) ? '🟢' : t.status === 'paused' ? '⏸' : '🔴';
        return [Markup.button.callback(`${live} @${t.botUsername}`, `s:bot:${t.id}`)];
    });
    rows.push([Markup.button.callback('➕ Yangi bot', 's:addbot'), Markup.button.callback('⬅️ Menyu', 's:menu')]);
    return reply(
        ctx,
        `🤖 <b>Botlar (${tenants.length})</b>\n\n🟢 ishlayapti · ⏸ to'xtatilgan · 🔴 yuklanmagan`,
        Markup.inlineKeyboard(rows),
    );
}

async function showTenant(ctx: Context, tenantId: string) {
    const t = await prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!t) return reply(ctx, 'Bot topilmadi.', back('s:bots'));

    const db = await tenantDb(t.botId);
    const [groups, members, coaches, meals, pending] = await Promise.all([
        db.group.count({ where: { isActive: true } }),
        db.member.count({ where: { status: 'active' } }),
        db.member.count({ where: { role: { in: ['coach', 'owner'] } } }),
        db.mealRecord.count(),
        db.outboundMessage.count({ where: { status: 'pending' } }),
    ]);
    const live = getEntry(t.botId) ? '🟢 ishlayapti' : t.status === 'paused' ? "⏸ to'xtatilgan" : '🔴 yuklanmagan';

    return reply(
        ctx,
        [
            `🤖 <b>@${esc(t.botUsername)}</b>`,
            live,
            '',
            `🏠 Guruhlar: <b>${groups}</b>`,
            `👥 A'zolar: <b>${members}</b> (murabbiy: ${coaches})`,
            `🍽 Ovqat qaydlari: <b>${meals}</b>`,
            `📭 Navbatdagi xabarlar: <b>${pending}</b>`,
            `💾 Fayl hajmi: <b>${humanSize(tenantDbSize(t.botId))}</b>`,
            `🌍 ${t.timezone}`,
            `📅 Qo'shilgan: ${formatIn(t.createdAt, safeTz(t.timezone), 'dd.MM.yyyy')}`,
        ].join('\n'),
        tenantMenu(t),
    );
}

async function showGroups(ctx: Context, tenantId: string) {
    const t = await prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!t) return;
    const db = await tenantDb(t.botId);
    const groups = await db.group.findMany({ where: { isActive: true }, orderBy: { createdAt: 'asc' } });

    const rows = await Promise.all(
        groups.map(async g => {
            const n = await db.groupMember.count({ where: { groupId: g.id } });
            return [
                Markup.button.callback(
                    `🗑 ${(g.title || g.chatId).slice(0, 26)} (${n})`,
                    `s:rmgroup:${tenantId}:${g.id}`,
                ),
            ];
        }),
    );
    rows.push([Markup.button.callback("➕ Guruh qo'shish", `s:addgroup:${tenantId}`)]);
    rows.push([Markup.button.callback('⬅️ Orqaga', `s:bot:${tenantId}`)]);

    return reply(
        ctx,
        groups.length
            ? `🏠 <b>Guruhlar (${groups.length})</b>\n\n<i>Nomga bosilsa ro'yxatdan chiqariladi (ma'lumot saqlanadi).</i>`
            : "🏠 Hali guruh yo'q.\n\n<i>Botni guruhga qo'shsangiz avtomatik ro'yxatga olinadi.</i>",
        Markup.inlineKeyboard(rows),
    );
}

async function showCoaches(ctx: Context, tenantId: string) {
    const t = await prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!t) return;
    const db = await tenantDb(t.botId);
    const coaches = await db.member.findMany({
        where: { role: { in: ['coach', 'owner'] } },
        orderBy: { joinedAt: 'asc' },
    });

    const rows = coaches.map(c => [
        Markup.button.callback(
            `${c.role === 'owner' ? '👑' : '🎯'} ${c.name}${c.role === 'owner' ? '' : ' ✕'}`,
            c.role === 'owner' ? `s:coaches:${tenantId}` : `s:rmcoach:${tenantId}:${c.id}`,
        ),
    ]);
    rows.push([Markup.button.callback("➕ Murabbiy qo'shish", `s:addcoach:${tenantId}`)]);
    rows.push([Markup.button.callback('⬅️ Orqaga', `s:bot:${tenantId}`)]);

    return reply(
        ctx,
        coaches.length
            ? `🎯 <b>Murabbiylar (${coaches.length})</b>\n\n👑 ega · 🎯 murabbiy\n<i>Nomga bosilsa murabbiylik olinadi.</i>`
            : '🎯 Hali murabbiy tayinlanmagan.',
        Markup.inlineKeyboard(rows),
    );
}

async function showOverview(ctx: Context) {
    const tenants = await prisma.tenant.findMany();
    const active = tenants.filter(t => t.status === 'active').length;

    let groups = 0;
    let members = 0;
    let meals = 0;
    let today = 0;
    const since = new Date(Date.now() - 24 * 3600_000);

    for (const t of tenants) {
        const db = await tenantDb(t.botId);
        groups += await db.group.count({ where: { isActive: true } });
        members += await db.member.count({ where: { status: 'active' } });
        meals += await db.mealRecord.count();
        today += await db.mealRecord.count({ where: { timeSent: { gte: since } } });
    }

    return reply(
        ctx,
        [
            '📊 <b>Platforma holati</b>',
            '',
            `🤖 Botlar: <b>${active}/${tenants.length}</b> faol`,
            `🏠 Guruhlar: <b>${groups}</b>`,
            `👥 A'zolar: <b>${members}</b>`,
            `🍽 Jami ovqat qaydi: <b>${meals}</b>`,
            `📈 Oxirgi 24 soatda: <b>${today}</b>`,
            '',
            `💾 Baza: <b>fayl</b> (${esc(DATA_DIR)})`,
            `🌐 PUBLIC_URL: ${env.PUBLIC_URL ? '✅' : '❌ sozlanmagan'}`,
            `🧠 AI: ${env.AI_ENABLED ? '✅ yoqilgan' : "⏸ o'chirilgan"}`,
        ].join('\n'),
        back('s:menu'),
    );
}

/// Disk hisoboti — "ortiqcha narx chiqmasin" degan talab uchun.
async function showDisk(ctx: Context) {
    const tenants = await prisma.tenant.findMany({ orderBy: { createdAt: 'asc' } });
    const platform = dbSizeBytes(platformDbPath());
    let total = platform;

    const lines = tenants.map(t => {
        const size = tenantDbSize(t.botId);
        total += size;
        return `• @${esc(t.botUsername)} — <b>${humanSize(size)}</b>`;
    });

    return reply(
        ctx,
        [
            '💾 <b>Disk hisoboti</b>',
            `<code>${esc(DATA_DIR)}</code>`,
            '',
            `Platforma bazasi — ${humanSize(platform)}`,
            ...lines,
            '',
            `<b>Jami: ${humanSize(total)}</b>`,
            '',
            '<i>Railway Volume odatda 5 GB dan boshlanadi — bu hajm uchun juda katta zaxira.</i>',
            "<i>Kattalashsa: bot → 🧹 Tozalash → \"30 kundan eskisi\".</i>",
        ].join('\n'),
        back('s:menu'),
    );
}

/// Webhook holati — Telegram botga xabar yubora olyaptimi yo'qmi, shu yerda ko'rinadi.
/// Bot "jim" bo'lib qolsa birinchi navbatda shu yerga qaraladi.
async function showWebhooks(ctx: Context) {
    if (!env.PUBLIC_URL) {
        return reply(
            ctx,
            "⚠️ <b>PUBLIC_URL sozlanmagan</b>\n\nWebhooklar o'rnatilmaydi va botlar hech qanday xabar olmaydi.\nRailway → Variables → PUBLIC_URL qo'shing.",
            back('s:menu'),
        );
    }

    const lines: string[] = ['🔌 <b>Webhook holati</b>', ''];

    const { controlSpec } = await import('../index');
    const spec = controlSpec();
    const cState = await getState(controlBot, spec.url);
    lines.push(`<b>Ona bot</b> — ${describe(cState)}`);

    const tenants = await prisma.tenant.findMany({ where: { status: 'active' }, orderBy: { createdAt: 'asc' } });
    for (const t of tenants) {
        const entry = getEntry(t.botId);
        if (!entry) {
            lines.push(`<b>@${esc(t.botUsername)}</b> — 🔴 yuklanmagan`);
            continue;
        }
        lines.push(`<b>@${esc(t.botUsername)}</b> — ${describe(await getState(entry.bot, tenantSpec(t).url))}`);
    }

    lines.push('', "<i>Har 10 daqiqada avtomatik tekshiriladi va tiklanadi.</i>");

    return reply(
        ctx,
        lines.join('\n'),
        Markup.inlineKeyboard([
            [Markup.button.callback('🔄 Hozir tiklash', 's:fixhooks')],
            [Markup.button.callback('⬅️ Menyu', 's:menu')],
        ]),
    );
}

function describe(state: Awaited<ReturnType<typeof getState>>): string {
    if (!state) return "⚠️ holatni olib bo'lmadi";
    if (!state.url) return "❌ o'rnatilmagan";
    if (!state.ok) return `⚠️ boshqa manzil: <code>${esc(state.url)}</code>`;
    const pending = state.pending > 0 ? ` · ${state.pending} kutayotgan` : '';
    const err = state.lastError ? `\n   ↳ oxirgi xato: <i>${esc(state.lastError)}</i>` : '';
    return `✅ ishlayapti${pending}${err}`;
}

async function showAdmins(ctx: Context) {
    const admins = await prisma.superAdmin.findMany({ orderBy: { createdAt: 'asc' } });
    const me = String(ctx.from!.id);
    const rows = admins.map(a => [
        Markup.button.callback(
            `${me === a.telegramId ? '👤' : '👑'} ${a.name || a.telegramId}${me === a.telegramId ? ' (siz)' : ' ✕'}`,
            me === a.telegramId ? 's:admins' : `s:rmadmin:${a.telegramId}`,
        ),
    ]);
    rows.push([Markup.button.callback("➕ Admin qo'shish", 's:addadmin')]);
    rows.push([Markup.button.callback('⬅️ Menyu', 's:menu')]);
    return reply(ctx, `👑 <b>Super adminlar (${admins.length})</b>`, Markup.inlineKeyboard(rows));
}

// ---------- utils ----------
function back(action: string, label = '⬅️ Orqaga') {
    return Markup.inlineKeyboard([[Markup.button.callback(label, action)]]);
}

function askTokenText() {
    return [
        "➕ <b>Yangi bot qo'shish</b>",
        '',
        "1. @BotFather ga o'ting va <code>/newbot</code> bilan bot yarating",
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
    if (count === 0) log.warn('control-bot', "SUPER_ADMIN_IDS bo'sh — ona botga hech kim kira olmaydi!");
}
