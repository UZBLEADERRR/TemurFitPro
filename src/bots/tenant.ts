import { Telegraf, Markup } from 'telegraf';
import type { Context } from 'telegraf';
import type { Tenant } from '../generated/platform';
import type { Member } from '../generated/tenant';
import type { TenantClient } from '../core/db';
import { find as findTz } from 'geo-tz';
import { prisma, tenantDb } from '../core/db';
import { log } from '../core/logger';
import { esc, chunkText, tgError } from '../core/telegram';
import { safeTz } from '../core/time';
import { MEAL_LABELS } from '../core/meals';
import { isCoachRole } from '../core/roles';
import { handleGroupMeal } from '../features/recording';
import { renderTable, updateGroupTable } from '../features/table';
import {
    findInactive, formatInactive, getStats, formatStats,
    findMissingToday, formatMissingToday, listMembers, memberReport, listGroups,
} from '../features/filters';
import { saveBusinessConnection, connectionSummary } from '../features/business';
import { enqueue } from '../features/outbox';
import { isSuperAdmin, addGroup, purgeGroupData } from '../core/tenants';
import { getTenantState, setTenantState, clearTenantState } from './session';
import { coachMenu, memberMenu, inactiveMenu, statsMenu, settingsMenu, backTo } from './ui';
import crypto from 'crypto';

// Har bir tenant boti uchun handlerlar shu yerda o'rnatiladi.
// tenantId closure orqali beriladi — bir jarayonda N ta bot mustaqil ishlaydi.

export function buildTenantBot(bot: Telegraf, tenantId: string): void {
    const loadTenant = async (): Promise<Tenant | null> => prisma.tenant.findUnique({ where: { id: tenantId } });

    /// Tenant + uning alohida bazasi
    async function load(): Promise<{ tenant: Tenant; db: TenantClient } | null> {
        const tenant = await loadTenant();
        if (!tenant) return null;
        return { tenant, db: await tenantDb(tenant.botId) };
    }

    // ---------- Guruhga qo'shilganda avtomatik ro'yxatga olish ----------
    bot.on('my_chat_member', async ctx => {
        const chat = ctx.myChatMember.chat;
        if (chat.type !== 'group' && chat.type !== 'supergroup') return;
        const ctxData = await load();
        if (!ctxData) return;
        const status = ctx.myChatMember.new_chat_member.status;

        if (status === 'member' || status === 'administrator') {
            const res = await addGroup(ctxData.tenant, String(chat.id), (chat as any).title || '').catch(() => null);
            if (res?.created) {
                log.info('tenant-bot', `yangi guruh ulandi: ${chat.id} (tenant=${tenantId})`);
                await ctx.telegram
                    .sendMessage(
                        chat.id,
                        [
                            '✅ <b>Bot ulandi!</b>',
                            '',
                            'Ovqat rasmini hashtag bilan yuboring:',
                            '<code>#nonushta</code> · <code>#tushlik</code> · <code>#kechki</code>',
                            '',
                            'Botni <b>admin</b> qiling — shunda jadvalni pinlay oladi va eslatmalarni tozalaydi.',
                        ].join('\n'),
                        { parse_mode: 'HTML' },
                    )
                    .catch(() => undefined);
            }
        } else if (status === 'left' || status === 'kicked') {
            await ctxData.db.group.updateMany({ where: { chatId: String(chat.id) }, data: { isActive: false } });
        }
    });

    // ---------- Telegram Business ulanishi ----------
    bot.on('business_connection' as any, async (ctx: any) => {
        const conn = ctx.update?.business_connection;
        if (!conn) return;
        const ctxData = await load();
        if (!ctxData) return;

        await saveBusinessConnection(ctxData.db, conn);
        const canReply = conn.rights?.can_reply ?? conn.can_reply ?? false;
        const text = conn.is_enabled
            ? canReply
                ? '✅ <b>Business ulanish faollashdi!</b>\n\nEndi men sizning nomingizdan shaxsiy xabar yubora olaman.'
                : "⚠️ <b>Ulandik, lekin javob berish huquqi yo'q.</b>\n\nTelegram → Sozlamalar → Business → Chatbots bo'limida <b>\"Reply to messages\"</b> ni yoqing."
            : "🔌 Business ulanish o'chirildi.";
        await ctx.telegram.sendMessage(conn.user_chat_id, text, { parse_mode: 'HTML' }).catch(() => undefined);
    });

    // ---------- /start ----------
    bot.start(async ctx => {
        if (ctx.chat.type !== 'private') return;
        const ctxData = await load();
        if (!ctxData) return;
        const { tenant, db } = ctxData;

        const telegramId = String(ctx.from.id);
        const name = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') || 'Foydalanuvchi';

        let member = await db.member.findUnique({ where: { telegramId } });
        if (!member) {
            // Birinchi kirgan odam avtomatik EGA (murabbiy) bo'ladi
            const count = await db.member.count();
            member = await db.member.create({
                data: {
                    telegramId,
                    name,
                    nameLc: name.toLowerCase(),
                    username: ctx.from.username ?? null,
                    role: count === 0 ? 'owner' : 'member',
                    timezone: tenant.timezone,
                    dmOpen: true,
                },
            });
        } else if (!member.dmOpen) {
            member = await db.member.update({ where: { id: member.id }, data: { dmOpen: true } });
        }

        await showMenu(ctx, tenant, db, member, true);
    });

    bot.command('menu', async ctx => {
        if (ctx.chat.type !== 'private') return;
        const ctxData = await load();
        if (!ctxData) return;
        const member = await ctxData.db.member.findUnique({ where: { telegramId: String(ctx.from.id) } });
        if (member) await showMenu(ctx, ctxData.tenant, ctxData.db, member, false);
    });

    bot.command('id', async ctx => {
        await ctx.reply(`Chat ID: <code>${ctx.chat.id}</code>`, { parse_mode: 'HTML' });
    });

    // ---------- Murabbiy buyruqlari ----------
    bot.command('saralash', async ctx => {
        const g = await requireCoach(ctx);
        if (!g) return;
        const days = Number((ctx.message as any).text.split(/\s+/)[1]) || 2;
        await showInactive(ctx, g.tenant, g.db, days, null);
    });

    bot.command('stat', async ctx => {
        const g = await requireCoach(ctx);
        if (!g) return;
        const days = Number((ctx.message as any).text.split(/\s+/)[1]) || 7;
        await reply(ctx, formatStats(await getStats(g.db, g.tenant, { days })), statsMenu(days));
    });

    bot.command('bugun', async ctx => {
        const g = await requireCoach(ctx);
        if (!g) return;
        await reply(ctx, await todayOverview(g.db, g.tenant), backTo('c:menu'));
    });

    // ---------- Callback tugmalar ----------
    bot.on('callback_query', async ctx => {
        const data = (ctx.callbackQuery as any).data as string | undefined;
        if (!data) return;
        await ctx.answerCbQuery().catch(() => undefined);

        const ctxData = await load();
        if (!ctxData) return;
        const { tenant, db } = ctxData;
        const member = await db.member.findUnique({ where: { telegramId: String(ctx.from.id) } });
        if (!member) return;

        const manager = isCoachRole(member.role) || (await isSuperAdmin(String(ctx.from.id)));
        const [ns, action, arg, extra] = data.split(':');

        try {
            if (ns === 'c') {
                if (!manager) {
                    await ctx
                        .answerCbQuery("Bu bo'lim faqat murabbiy uchun", { show_alert: true })
                        .catch(() => undefined);
                    return;
                }
                await handleCoachAction(ctx, tenant, db, action, arg, extra);
            } else if (ns === 'm') {
                await handleMemberAction(ctx, db, member, action);
            }
        } catch (e) {
            log.error('tenant-bot', `callback xatosi (${data})`, e);
            await ctx.reply("⚠️ Xatolik yuz berdi, qaytadan urinib ko'ring.").catch(() => undefined);
        }
    });

    // ---------- Guruh xabarlari: ovqat qaydi ----------
    bot.on(['photo', 'video'], async ctx => {
        if (ctx.chat.type === 'private') {
            await ctx.reply(
                '📸 Ovqat rasmini <b>guruhga</b> yuboring — shaxsiy chatda qayd etilmaydi.\n\n' +
                    'Hashtag bilan: <code>#nonushta</code> · <code>#tushlik</code> · <code>#kechki</code>',
                { parse_mode: 'HTML' },
            );
            return;
        }
        const ctxData = await load();
        if (!ctxData) return;
        const group = await ctxData.db.group.findUnique({ where: { chatId: String(ctx.chat.id) } });
        if (!group?.isActive) return;
        await handleGroupMeal(ctx, ctxData.db, ctxData.tenant, group).catch(e =>
            log.error('tenant-bot', `ovqat qaydida xato: ${tgError(e)}`),
        );
    });

    // ---------- Matnli xabarlar ----------
    bot.on('text', async ctx => {
        const ctxData = await load();
        if (!ctxData) return;
        const { tenant, db } = ctxData;

        if (ctx.chat.type !== 'private') {
            // Guruhda: rasm majburiy bo'lmasa hashtag ham qabul qilinadi
            if (tenant.requirePhoto) return;
            const group = await db.group.findUnique({ where: { chatId: String(ctx.chat.id) } });
            if (group?.isActive) await handleGroupMeal(ctx, db, tenant, group).catch(() => undefined);
            return;
        }

        const text = ctx.message.text.trim();
        if (text.startsWith('/')) return;

        const member = await db.member.findUnique({ where: { telegramId: String(ctx.from.id) } });
        if (!member) return;

        const session = await getTenantState(tenant.botId, String(ctx.chat.id));
        if (session.state.startsWith('await:')) {
            await handleAwaitedInput(ctx, tenant, db, session.state.slice(6), text, session.payload);
            return;
        }

        await showMenu(ctx, tenant, db, member, false);
    });

    // ---------- Lokatsiya: vaqt mintaqasini aniqlash ----------
    bot.on('location', async ctx => {
        if (ctx.chat.type !== 'private') return;
        const ctxData = await load();
        if (!ctxData) return;
        const member = await ctxData.db.member.findUnique({ where: { telegramId: String(ctx.from.id) } });
        if (!member) return;

        const loc = (ctx.message as any).location;
        const timezone = safeTz(findTz(loc.latitude, loc.longitude)[0]);
        await ctxData.db.member.update({
            where: { id: member.id },
            data: { latitude: loc.latitude, longitude: loc.longitude, timezone },
        });
        await ctx.reply(
            `✅ Vaqt mintaqangiz aniqlandi: <b>${timezone}</b>\n\nEndi eslatmalar mahalliy vaqtingizda keladi.`,
            { parse_mode: 'HTML', ...Markup.removeKeyboard() },
        );
    });

    // ================= YORDAMCHILAR =================

    async function requireCoach(ctx: Context): Promise<{ tenant: Tenant; db: TenantClient } | null> {
        if (ctx.chat?.type !== 'private') return null;
        const ctxData = await load();
        if (!ctxData) return null;
        const member = await ctxData.db.member.findUnique({ where: { telegramId: String(ctx.from!.id) } });
        const ok = (member && isCoachRole(member.role)) || (await isSuperAdmin(String(ctx.from!.id)));
        if (!ok) {
            await ctx.reply('Bu buyruq faqat murabbiy uchun.').catch(() => undefined);
            return null;
        }
        return ctxData;
    }

    async function showMenu(ctx: Context, tenant: Tenant, db: TenantClient, member: Member, greet: boolean) {
        const manager = isCoachRole(member.role) || (await isSuperAdmin(String(ctx.from!.id)));

        if (manager) {
            const groups = await db.group.count({ where: { isActive: true } });
            const people = await db.member.count({ where: { status: 'active', role: 'member' } });
            const head = greet
                ? `👋 Salom, <b>${esc(member.name)}</b>!\n\n🏠 ${groups} guruh · 👥 ${people} a'zo`
                : `🏋️ <b>Boshqaruv paneli</b>\n\n🏠 ${groups} guruh · 👥 ${people} a'zo`;
            await reply(ctx, head, coachMenu(tenant.id));
            return;
        }

        await reply(
            ctx,
            greet
                ? `👋 Salom, <b>${esc(member.name)}</b>!\n\nRatsioningizni guruhga hashtag bilan yuboring:\n` +
                      `<code>#nonushta</code> · <code>#tushlik</code> · <code>#kechki</code>`
                : '📋 <b>Menyu</b>',
            memberMenu(tenant.id),
        );
    }

    /// Yubormaganlar ekrani — standart holatda BARCHA guruhlar bo'ylab
    async function showInactive(
        ctx: Context,
        tenant: Tenant,
        db: TenantClient,
        days: number,
        groupId: string | null,
    ) {
        const rows = await findInactive(db, tenant, { days, groupId });
        const totalGroups = await db.group.count({ where: { isActive: true } });
        await setTenantState(tenant.botId, String(ctx.chat!.id), 'idle', { days, groupId });
        await reply(ctx, formatInactive(rows, days, totalGroups), inactiveMenu(days, groupId));
    }

    async function handleCoachAction(
        ctx: Context,
        tenant: Tenant,
        db: TenantClient,
        action: string,
        arg?: string,
        extra?: string,
    ) {
        const chatId = String(ctx.chat!.id);

        switch (action) {
            case 'menu': {
                const member = await db.member.findUnique({ where: { telegramId: String(ctx.from!.id) } });
                if (member) await showMenu(ctx, tenant, db, member, false);
                return;
            }

            case 'inactive': {
                const st = await getTenantState(tenant.botId, chatId);
                const groupId = (st.payload.groupId as string | null) ?? null;
                // Kun tugmasi bosilganda guruh filtri saqlanadi; "barcha guruhlar" bosilsa tozalanadi
                await showInactive(ctx, tenant, db, Number(arg) || 2, extra === 'keep' ? groupId : null);
                return;
            }

            case 'pickgroup': {
                const groups = await listGroups(db);
                if (groups.length <= 1) {
                    await reply(ctx, "Faqat bitta guruh bor — filtr kerak emas.", backTo('c:menu'));
                    return;
                }
                const rows = groups.map(g => [
                    Markup.button.callback(`🏠 ${(g.title || g.chatId).slice(0, 30)}`, `c:ingroup:${g.id}`),
                ]);
                rows.push([Markup.button.callback('⬅️ Orqaga', 'c:inactive:2')]);
                await reply(ctx, '🏠 <b>Qaysi guruh?</b>', Markup.inlineKeyboard(rows));
                return;
            }

            case 'ingroup': {
                const st = await getTenantState(tenant.botId, chatId);
                await showInactive(ctx, tenant, db, Number(st.payload.days) || 2, arg ?? null);
                return;
            }

            case 'today':
                await reply(ctx, await todayOverview(db, tenant), backTo('c:menu'));
                return;

            case 'stats': {
                const days = Number(arg) || 7;
                await reply(ctx, formatStats(await getStats(db, tenant, { days })), statsMenu(days));
                return;
            }

            case 'members': {
                const rows = await listMembers(db);
                const lines = rows.slice(0, 80).map((r, i) => {
                    const badge = r.role === 'owner' ? ' 👑' : r.role === 'coach' ? ' 🎯' : '';
                    const grp = r.groups.length ? ` <i>${esc(r.groups.join(', '))}</i>` : '';
                    return `${i + 1}. ${esc(r.name)}${badge}${grp}`;
                });
                await reply(ctx, [`👥 <b>A'zolar: ${rows.length}</b>`, '', ...lines].join('\n'), backTo('c:menu'));
                return;
            }

            case 'groups': {
                const groups = await listGroups(db);
                if (groups.length === 0) {
                    await reply(
                        ctx,
                        "🏠 Hali guruh yo'q.\n\n<i>Botni guruhga qo'shsangiz avtomatik ro'yxatga olinadi.</i>",
                        backTo('c:menu'),
                    );
                    return;
                }
                const rows = await Promise.all(
                    groups.map(async g => {
                        const n = await db.groupMember.count({ where: { groupId: g.id } });
                        return [
                            Markup.button.callback(`🏠 ${(g.title || g.chatId).slice(0, 26)} (${n})`, `c:group:${g.id}`),
                        ];
                    }),
                );
                rows.push([Markup.button.callback('⬅️ Menyu', 'c:menu')]);
                await reply(
                    ctx,
                    `🏠 <b>Guruhlar: ${groups.length}</b>\n\n<i>Guruhni tanlab tozalash yoki uzish mumkin.</i>`,
                    Markup.inlineKeyboard(rows),
                );
                return;
            }

            case 'group': {
                const group = await db.group.findUnique({ where: { id: arg! } });
                if (!group) return;
                const [people, meals] = await Promise.all([
                    db.groupMember.count({ where: { groupId: group.id } }),
                    db.mealRecord.count({ where: { groupId: group.id } }),
                ]);
                await reply(
                    ctx,
                    [
                        `🏠 <b>${esc(group.title || group.chatId)}</b>`,
                        `<code>${group.chatId}</code>`,
                        '',
                        `👥 A'zolar: <b>${people}</b>`,
                        `🍽 Ovqat qaydlari: <b>${meals}</b>`,
                    ].join('\n'),
                    Markup.inlineKeyboard([
                        [Markup.button.callback('📊 Shu guruh jadvali', `c:gtable:${group.id}`)],
                        [Markup.button.callback("🧹 Ma'lumotlarini tozalash", `c:gpurge:${group.id}`)],
                        [Markup.button.callback('⬅️ Guruhlar', 'c:groups')],
                    ]),
                );
                return;
            }

            case 'gtable': {
                const group = await db.group.findUnique({ where: { id: arg! } });
                if (group) await reply(ctx, await renderTable(db, tenant, group), backTo(`c:group:${arg}`));
                return;
            }

            case 'gpurge': {
                await reply(
                    ctx,
                    "⚠️ <b>Tasdiqlang</b>\n\nShu guruhning ovqat tarixi, eslatmalari va faqat shu guruhdagi a'zolari o'chiriladi. Qaytarib bo'lmaydi.",
                    Markup.inlineKeyboard([
                        [Markup.button.callback("✅ Ha, tozala", `c:gpurgeok:${arg}`)],
                        [Markup.button.callback('❌ Bekor', `c:group:${arg}`)],
                    ]),
                );
                return;
            }

            case 'gpurgeok': {
                const summary = await purgeGroupData(tenant, arg!, String(ctx.from!.id));
                await reply(ctx, `🧹 Tozalandi: ${esc(summary)}`, backTo('c:groups'));
                return;
            }

            case 'settings':
                await reply(ctx, settingsText(tenant), settingsMenu(tenant));
                return;

            case 'business':
                await reply(ctx, await connectionSummary(db), backTo('c:menu'));
                return;

            case 'warn': {
                const st = await getTenantState(tenant.botId, chatId);
                const days = Number(st.payload.days) || 2;
                const groupId = (st.payload.groupId as string | null) ?? null;
                const rows = await findInactive(db, tenant, { days, groupId });
                if (rows.length === 0) {
                    await reply(ctx, "✅ Ogohlantirish kerak bo'lgan a'zo yo'q.", backTo('c:menu'));
                    return;
                }
                await setTenantState(tenant.botId, chatId, 'await:warnText', {
                    memberIds: rows.map(r => r.id),
                    days,
                    groupId,
                });
                await reply(
                    ctx,
                    [
                        `✉️ <b>${rows.length} ta a'zoga ogohlantirish</b>`,
                        rows.map(r => `• ${esc(r.name)}`).join('\n'),
                        '',
                        'Yuboriladigan matnni yozing. <code>{name}</code> — ismga almashadi.',
                        '',
                        '<i>Xabar sizning nomingizdan (Telegram Business) yuboriladi.</i>',
                    ].join('\n'),
                    backTo('c:menu', '❌ Bekor qilish'),
                );
                return;
            }

            case 'set':
                if (!arg) return;
                await setTenantState(tenant.botId, chatId, `await:${arg}`);
                await reply(ctx, settingPrompt(arg), backTo('c:settings', '❌ Bekor qilish'));
                return;

            case 'toggle':
                if (arg === 'requirePhoto') {
                    const updated = await prisma.tenant.update({
                        where: { id: tenantId },
                        data: { requirePhoto: !tenant.requirePhoto },
                    });
                    await reply(ctx, settingsText(updated), settingsMenu(updated));
                }
                return;
        }
    }

    async function handleMemberAction(ctx: Context, db: TenantClient, member: Member, action: string) {
        if (action === 'me') {
            const rep = await memberReport(db, member.id, 7);
            if (!rep) return;
            const lines = rep.byDate.map(d => {
                const marks = d.meals
                    .map(m => (m.status === 'missing' ? '⚪️' : m.status === 'late' ? '🟡' : '🟢'))
                    .join('');
                return `<code>${d.date}</code>  ${marks}`;
            });
            const pct = Math.round((rep.total / rep.expected) * 100);
            await reply(
                ctx,
                [
                    `📊 <b>${esc(member.name)} — 7 kunlik natija</b>`,
                    '',
                    ...lines,
                    '',
                    `Bajarildi: <b>${rep.total}/${rep.expected}</b> (${pct}%)`,
                    '',
                    '<i>Tartib: nonushta · tushlik · kechki</i>',
                ].join('\n'),
                backTo('m:menu'),
            );
            return;
        }

        if (action === 'reminders') {
            const overrides = await db.reminderOverride.findMany({ where: { memberId: member.id, muted: true } });
            const muted = overrides.map(o => MEAL_LABELS[o.mealType as keyof typeof MEAL_LABELS] ?? o.mealType);
            await reply(
                ctx,
                muted.length
                    ? `🔕 O'chirilgan eslatmalar: <b>${muted.join(', ')}</b>\n\nQayta yoqish uchun murabbiyga murojaat qiling.`
                    : '🔔 Barcha eslatmalar yoqilgan.',
                backTo('m:menu'),
            );
            return;
        }

        if (action === 'menu') {
            const t = await loadTenant();
            if (t) await reply(ctx, '📋 <b>Menyu</b>', memberMenu(t.id));
        }
    }

    async function handleAwaitedInput(
        ctx: Context,
        tenant: Tenant,
        db: TenantClient,
        field: string,
        text: string,
        payload: Record<string, unknown>,
    ) {
        const chatId = String(ctx.chat!.id);

        if (field === 'warnText') {
            const memberIds = (payload.memberIds as string[]) ?? [];
            await clearTenantState(tenant.botId, chatId);
            if (!memberIds.length) {
                await reply(ctx, "A'zolar ro'yxati eskirgan, qaytadan boshlang.", backTo('c:menu'));
                return;
            }
            const members = await db.member.findMany({ where: { id: { in: memberIds } } });
            const batchId = crypto.randomUUID();
            for (const m of members) {
                await enqueue(db, {
                    memberId: m.id,
                    chatId: m.telegramId,
                    text: text.replace(/\{name\}/g, esc(m.name)),
                    channel: 'business',
                    createdByTgId: String(ctx.from!.id),
                    batchId,
                });
            }
            await reply(
                ctx,
                `✅ ${members.length} ta xabar navbatga qo'yildi — bir daqiqa ichida sizning nomingizdan yuboriladi.`,
                backTo('c:menu'),
            );
            return;
        }

        const data: Record<string, unknown> = {};
        if (['breakfastTime', 'lunchTime', 'dinnerTime'].includes(field)) {
            if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(text)) {
                await reply(ctx, "❌ Vaqt <code>HH:mm</code> ko'rinishida bo'lsin, masalan <code>08:30</code>.");
                return;
            }
            data[field] = text;
        } else if (field === 'reminderInterval' || field === 'maxReminders') {
            const n = Number(text);
            const [min, max] = field === 'reminderInterval' ? [5, 1440] : [0, 20];
            if (!Number.isFinite(n) || n < min || n > max) {
                await reply(ctx, `❌ ${min}..${max} oralig'ida son kiriting.`);
                return;
            }
            data[field] = Math.round(n);
        } else {
            await clearTenantState(tenant.botId, chatId);
            return;
        }

        const updated = await prisma.tenant.update({ where: { id: tenantId }, data });
        await clearTenantState(tenant.botId, chatId);
        await reply(ctx, '✅ Saqlandi.\n\n' + settingsText(updated), settingsMenu(updated));
    }

    /// Barcha guruhlarning bugungi holati — bitta ekranda
    async function todayOverview(db: TenantClient, tenant: Tenant): Promise<string> {
        const groups = await listGroups(db);
        if (groups.length === 0) {
            return "📭 Hali guruh ulanmagan.\n\nBotni guruhga qo'shing — u avtomatik ro'yxatga olinadi.";
        }
        const parts: string[] = [];
        for (const g of groups) parts.push(await renderTable(db, tenant, g));
        parts.push(formatMissingToday(await findMissingToday(db, {})));
        return parts.join('\n\n──────────\n\n');
    }
}

// ================= UMUMIY =================

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
                log.warn('tenant-bot', `HTML xatosi, plain text: ${tgError(e)}`);
                await ctx.reply(chunks[i].replace(/<[^>]+>/g, '')).catch(() => undefined);
            });
    }
}

function settingsText(t: Tenant): string {
    return [
        '⚙️ <b>Sozlamalar</b>',
        '',
        `🌅 Nonushta: <b>${t.breakfastTime}</b>`,
        `🌞 Tushlik: <b>${t.lunchTime}</b>`,
        `🌙 Kechki: <b>${t.dinnerTime}</b>`,
        `⏱ Eslatma oralig'i: <b>${t.reminderInterval} daqiqa</b> · maks <b>${t.maxReminders}</b>`,
        `🕐 Kechikish chegarasi: <b>${t.graceMinutes} daqiqa</b>`,
        `📷 Rasm majburiy: <b>${t.requirePhoto ? 'ha' : "yo'q"}</b>`,
        `🌍 Vaqt mintaqasi: <b>${t.timezone}</b>`,
    ].join('\n');
}

function settingPrompt(field: string): string {
    const prompts: Record<string, string> = {
        breakfastTime: '🌅 Nonushta vaqtini kiriting (<code>HH:mm</code>, masalan <code>08:00</code>):',
        lunchTime: '🌞 Tushlik vaqtini kiriting (<code>HH:mm</code>):',
        dinnerTime: '🌙 Kechki ovqat vaqtini kiriting (<code>HH:mm</code>):',
        reminderInterval: '⏱ Eslatmalar orasidagi daqiqani kiriting (5-1440):',
        maxReminders: '🔁 Bir ovqat uchun maksimal eslatma sonini kiriting (0-20):',
    };
    return prompts[field] ?? 'Qiymatni kiriting:';
}
