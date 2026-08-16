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
import { MEAL_LABELS, MEAL_TYPES, isMealType, type MealType } from '../core/meals';
import { isCoachRole } from '../core/roles';
import { handleGroupMeal } from '../features/recording';
import { renderTable, updateGroupTable } from '../features/table';
import {
    findInactive, formatInactive, getStats, formatStats,
    findMissingToday, formatMissingToday, listMembers, memberReport, listGroups,
} from '../features/filters';
import { saveBusinessConnection, connectionSummary } from '../features/business';
import { enqueue } from '../features/outbox';
import { isSuperAdmin, registerIncomingGroup, markGroupLeft } from '../core/tenants';
import { notifySuperAdmins } from '../features/notify';
import { LIVE_GROUP, statusBadge } from '../core/groups';
import { getTenantState, setTenantState, clearTenantState } from './session';
import { ask, aiAvailable, aiOffReason, clearHistory } from '../ai/agent';
import type { Role } from '../core/roles';
import { downloadFile } from '../core/telegram';
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
            const title = (chat as any).title || '';
            const g = await registerIncomingGroup(ctxData.tenant, String(chat.id), title).catch(e => {
                log.error('tenant-bot', `guruhni ro'yxatga olishda xato: ${tgError(e)}`);
                return null;
            });
            if (!g) return;

            if (!g.needsApproval) {
                // Ilgari tasdiqlangan guruh — bot qaytib keldi
                log.info('tenant-bot', `tasdiqlangan guruhga qaytdi: ${chat.id}`);
                await ctx.telegram
                    .sendMessage(chat.id, welcomeText(), { parse_mode: 'HTML' })
                    .catch(() => undefined);
                return;
            }

            log.info('tenant-bot', `yangi guruh tasdiq kutmoqda: ${chat.id} (tenant=${tenantId})`);
            await askSuperAdminApproval(ctxData.tenant, g, chat);
        } else if (status === 'left' || status === 'kicked') {
            await markGroupLeft(ctxData.tenant, String(chat.id));
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

    bot.command('tozalash', async ctx => {
        if (ctx.chat.type !== 'private') return;
        const t = await loadTenant();
        if (!t) return;
        const n = await clearHistory(t, String(ctx.from.id));
        await ctx.reply(`🧹 AI suhbat tarixi tozalandi (${n} xabar).`);
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
        // Tasdiqlanmagan guruhda hech narsa qayd etilmaydi
        const group = await ctxData.db.group.findFirst({
            where: { chatId: String(ctx.chat.id), ...LIVE_GROUP },
        });
        if (!group) return;
        await handleGroupMeal(ctx, ctxData.db, ctxData.tenant, group).catch(e =>
            log.error('tenant-bot', `ovqat qaydida xato: ${tgError(e)}`),
        );
    });

    // ---------- Ovozli xabar: AI ----------
    bot.on(['voice', 'audio'], async ctx => {
        if (ctx.chat.type !== 'private') return;
        const ctxData = await load();
        if (!ctxData) return;
        const { tenant, db } = ctxData;

        const member = await db.member.findUnique({ where: { telegramId: String(ctx.from.id) } });
        if (!member) return;

        if (!aiAvailable(tenant)) {
            await ctx.reply(aiOffReason(tenant));
            return;
        }

        const file = (ctx.message as any).voice ?? (ctx.message as any).audio;
        if (!file) return;

        await ctx.sendChatAction('typing').catch(() => undefined);
        try {
            const buffer = await downloadFile(bot, file.file_id);
            const res = await ask({
                tenant,
                actorTgId: String(ctx.from.id),
                actorName: member.name,
                role: await roleOf(member, String(ctx.from.id)),
                audio: { buffer, mimeType: file.mime_type || 'audio/ogg' },
            });
            await reply(ctx, (res.transcript ? `🎙 <i>${esc(res.transcript)}</i>\n\n` : '') + res.reply);
        } catch (e) {
            log.error('tenant-bot', 'ovozli xabar xatosi', e);
            await ctx.reply("🎙 Ovozli xabarni qayta ishlab bo'lmadi.");
        }
    });

    // ---------- Matnli xabarlar ----------
    bot.on('text', async ctx => {
        const ctxData = await load();
        if (!ctxData) return;
        const { tenant, db } = ctxData;

        if (ctx.chat.type !== 'private') {
            // Guruhda: rasm majburiy bo'lmasa hashtag ham qabul qilinadi
            if (tenant.requirePhoto) return;
            const group = await db.group.findFirst({ where: { chatId: String(ctx.chat.id), ...LIVE_GROUP } });
            if (group) await handleGroupMeal(ctx, db, tenant, group).catch(() => undefined);
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

        // Erkin matn — AI ga. AI yo'q bo'lsa menyuni ko'rsatamiz.
        if (!aiAvailable(tenant)) {
            await showMenu(ctx, tenant, db, member, false);
            return;
        }

        await ctx.sendChatAction('typing').catch(() => undefined);
        const res = await ask({
            tenant,
            actorTgId: String(ctx.from.id),
            actorName: member.name,
            role: await roleOf(member, String(ctx.from.id)),
            text,
        });
        await reply(ctx, res.reply);
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

    async function roleOf(member: Member, telegramId: string): Promise<Role> {
        if (await isSuperAdmin(telegramId)) return 'super';
        return isCoachRole(member.role) ? 'coach' : 'member';
    }

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
            const groups = await db.group.count({ where: LIVE_GROUP });
            const people = await db.member.count({ where: { status: 'active', role: 'member' } });
            const head = greet
                ? `👋 Salom, <b>${esc(member.name)}</b>!\n\n🏠 ${groups} guruh · 👥 ${people} a'zo`
                : `🏋️ <b>Boshqaruv paneli</b>\n\n🏠 ${groups} guruh · 👥 ${people} a'zo`;
            await reply(ctx, head, coachMenu(tenant.id, aiAvailable(tenant) ? tenant.agentName : undefined));
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
        const totalGroups = await db.group.count({ where: LIVE_GROUP });
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
                if (rows.length === 0) {
                    await reply(ctx, "👥 Hali a'zo yo'q.", backTo('c:menu'));
                    return;
                }
                // Ismga bosilsa — o'sha a'zoning kartasi (eslatmalarni boshqarish uchun)
                const buttons = rows.slice(0, 60).map(r => {
                    const badge = r.role === 'owner' ? '👑' : r.role === 'coach' ? '🎯' : '👤';
                    return [Markup.button.callback(`${badge} ${r.name.slice(0, 30)}`, `c:m:${r.id}`)];
                });
                buttons.push([Markup.button.callback('⬅️ Menyu', 'c:menu')]);
                await reply(
                    ctx,
                    [
                        `👥 <b>A'zolar: ${rows.length}</b>`,
                        '',
                        '<i>Ismga bosing — eslatmalarini boshqarasiz.</i>',
                    ].join('\n'),
                    Markup.inlineKeyboard(buttons),
                );
                return;
            }

            // A'zo kartasi: natija + eslatma tugmalari
            case 'm': {
                await showMemberCard(ctx, db, tenant, arg!);
                return;
            }

            // Eslatmani yoqish/o'chirish: c:mr:<memberId>:<meal>
            case 'mr': {
                const memberId = arg!;
                const meal = extra as MealType;
                if (!isMealType(meal)) return;

                const existing = await db.reminderOverride.findUnique({
                    where: { memberId_mealType: { memberId, mealType: meal } },
                });

                if (existing?.muted) {
                    await db.reminderOverride.deleteMany({ where: { memberId, mealType: meal } });
                } else {
                    await db.reminderOverride.upsert({
                        where: { memberId_mealType: { memberId, mealType: meal } },
                        create: { memberId, mealType: meal, muted: true },
                        update: { muted: true },
                    });
                }
                await showMemberCard(ctx, db, tenant, memberId);
                return;
            }

            case 'groups': {
                const all = await db.group.findMany({ where: { isActive: true }, orderBy: { createdAt: 'asc' } });
                if (all.length === 0) {
                    await reply(
                        ctx,
                        "🏠 Hali guruh yo'q.\n\n<i>Botni guruhga qo'shing — administrator tasdiqlagach ishga tushadi.</i>",
                        backTo('c:menu'),
                    );
                    return;
                }
                const rows = await Promise.all(
                    all.map(async g => {
                        const n = await db.groupMember.count({ where: { groupId: g.id } });
                        const mark = g.status === 'approved' ? '🏠' : g.status === 'pending' ? '⏳' : '❌';
                        return [
                            Markup.button.callback(
                                `${mark} ${(g.title || g.chatId).slice(0, 24)} (${n})`,
                                `c:group:${g.id}`,
                            ),
                        ];
                    }),
                );
                rows.push([Markup.button.callback('⬅️ Menyu', 'c:menu')]);

                const waiting = all.filter(g => g.status === 'pending').length;
                await reply(
                    ctx,
                    [
                        `🏠 <b>Guruhlar: ${all.length}</b>`,
                        waiting ? `⏳ ${waiting} tasi administrator tasdig'ini kutmoqda` : '',
                        '',
                        '<i>Guruh qo\'shish va tasdiqlash administratorda.</i>',
                    ]
                        .filter(Boolean)
                        .join('\n'),
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
                        `${statusBadge(group)}`,
                        '',
                        `👥 A'zolar: <b>${people}</b>`,
                        `🍽 Ovqat qaydlari: <b>${meals}</b>`,
                    ].join('\n'),
                    Markup.inlineKeyboard([
                        [Markup.button.callback('📊 Shu guruh jadvali', `c:gtable:${group.id}`)],
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

            case 'ai':
                await reply(
                    ctx,
                    [
                        `🤖 <b>${esc(tenant.agentName)} bilan suhbat</b>`,
                        '',
                        'Shunchaki yozing yoki ovozli xabar yuboring. Masalan:',
                        '• <i>"oxirgi 3 kunda kechki ovqat yubormaganlarni top"</i>',
                        '• <i>"ularga ertaga soat 9 da ogohlantirish yubor"</i>',
                        '• <i>"Dilnozaning nonushta eslatmasini o\'chir"</i>',
                        '• <i>"nonushta vaqtini 07:30 ga o\'zgartir"</i>',
                        '',
                        'Suhbat tarixini tozalash: /tozalash',
                    ].join('\n'),
                    backTo('c:menu'),
                );
                return;

            case 'settings':
                await reply(ctx, settingsText(tenant, aiAvailable(tenant)), settingsMenu(tenant, aiAvailable(tenant)));
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
                    await reply(ctx, settingsText(updated, aiAvailable(updated)), settingsMenu(updated, aiAvailable(updated)));
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
        } else if (field === 'agentName') {
            data.agentName = text.slice(0, 40);
        } else if (field === 'coachStyle') {
            data.coachStyle = text.slice(0, 2000);
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
        await reply(ctx, '✅ Saqlandi.\n\n' + settingsText(updated, aiAvailable(updated)), settingsMenu(updated, aiAvailable(updated)));
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

/// A'zo kartasi — 7 kunlik natija va har bir ovqat uchun eslatma tugmasi.
/// Murabbiy shu yerdan istagan a'zoning istagan ovqati bo'yicha eslatmani
/// o'chirib qo'ya oladi (masalan odam nonushta qilmaydigan bo'lsa).
async function showMemberCard(ctx: Context, db: TenantClient, tenant: Tenant, memberId: string) {
    const member = await db.member.findUnique({ where: { id: memberId } });
    if (!member) return;

    const rep = await memberReport(db, memberId, 7);
    const overrides = await db.reminderOverride.findMany({ where: { memberId, muted: true } });
    const mutedSet = new Set(overrides.map(o => o.mealType));

    const lines = [
        `👤 <b>${esc(member.name)}</b>`,
        member.username ? `@${esc(member.username)}` : '',
        `🌍 ${member.timezone}`,
        '',
    ].filter(Boolean);

    if (rep) {
        const pct = Math.round((rep.total / rep.expected) * 100);
        const grid = rep.byDate
            .map(d => d.meals.map(m => (m.status === 'missing' ? '⚪️' : m.status === 'late' ? '🟡' : '🟢')).join(''))
            .join(' ');
        lines.push(`📊 7 kun: <b>${rep.total}/${rep.expected}</b> (${pct}%)`, `<code>${grid}</code>`, '');
    }

    lines.push(
        mutedSet.size
            ? `🔕 O'chirilgan: <b>${[...mutedSet].map(m => MEAL_LABELS[m as MealType] ?? m).join(', ')}</b>`
            : '🔔 Barcha eslatmalar yoqilgan',
        '',
        '<i>Tugmani bosib eslatmani o\'chirasiz yoki yoqasiz.</i>',
    );

    const toggles = MEAL_TYPES.map(meal => {
        const muted = mutedSet.has(meal);
        return Markup.button.callback(
            `${muted ? '🔕' : '🔔'} ${MEAL_LABELS[meal]}`,
            `c:mr:${memberId}:${meal}`,
        );
    });

    await reply(
        ctx,
        lines.join('\n'),
        Markup.inlineKeyboard([
            [toggles[0]],
            [toggles[1]],
            [toggles[2]],
            [Markup.button.callback("⬅️ A'zolar", 'c:members')],
        ]),
    );
}

/// Guruhga yuboriladigan tanishtiruv matni
function welcomeText(): string {
    return [
        '✅ <b>Bot ishga tushdi!</b>',
        '',
        'Ovqat rasmini hashtag bilan yuboring:',
        '<code>#nonushta</code> · <code>#tushlik</code> · <code>#kechki</code>',
        '',
        'Botni <b>admin</b> qiling — shunda jadvalni pinlay oladi va eslatmalarni tozalaydi.',
    ].join('\n');
}

/// Yangi guruh uchun super admindan tasdiq so'rash.
/// Guruhlarni faqat super admin qabul qiladi, shuning uchun bot guruhda
/// tasdiqlangunicha jim turadi.
async function askSuperAdminApproval(tenant: Tenant, g: { id: string; title: string; chatId: string }, chat: any) {
    const memberCount = await (async () => {
        try {
            const { getBotByTenant } = await import('../core/registry');
            const bot = getBotByTenant(tenant.id);
            return bot ? await bot.telegram.getChatMembersCount(chat.id) : null;
        } catch {
            return null;
        }
    })();

    const sent = await notifySuperAdmins(
        [
            '🆕 <b>Yangi guruh tasdiq kutmoqda</b>',
            '',
            `🤖 Bot: @${esc(tenant.botUsername)}`,
            `🏠 Guruh: <b>${esc(g.title || '(nomsiz)')}</b>`,
            `🆔 <code>${g.chatId}</code>`,
            memberCount !== null ? `👥 A'zolar: ${memberCount}` : '',
            '',
            "<i>Tasdiqlanmaguncha bu guruhda hech narsa qayd etilmaydi.</i>",
        ]
            .filter(Boolean)
            .join('\n'),
        Markup.inlineKeyboard([
            [
                Markup.button.callback('✅ Tasdiqlash', `s:gok:${tenant.id}:${g.id}`),
                Markup.button.callback('❌ Rad etish', `s:gno:${tenant.id}:${g.id}`),
            ],
        ]),
    );

    if (sent === 0) {
        log.warn('tenant-bot', "guruh tasdig'i uchun hech bir super adminga xabar yetmadi");
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

function settingsText(t: Tenant, aiOn = false): string {
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
        ...(aiOn
            ? [
                  '',
                  `🤖 AI ismi: <b>${esc(t.agentName)}</b>`,
                  t.coachStyle
                      ? `✍️ Yozish uslubi:\n<i>${esc(t.coachStyle.slice(0, 250))}</i>`
                      : "✍️ Yozish uslubi kiritilmagan",
              ]
            : []),
    ].join('\n');
}

function settingPrompt(field: string): string {
    const prompts: Record<string, string> = {
        breakfastTime: '🌅 Nonushta vaqtini kiriting (<code>HH:mm</code>, masalan <code>08:00</code>):',
        lunchTime: '🌞 Tushlik vaqtini kiriting (<code>HH:mm</code>):',
        dinnerTime: '🌙 Kechki ovqat vaqtini kiriting (<code>HH:mm</code>):',
        reminderInterval: '⏱ Eslatmalar orasidagi daqiqani kiriting (5-1440):',
        maxReminders: '🔁 Bir ovqat uchun maksimal eslatma sonini kiriting (0-20):',
        agentName: '🤖 AI yordamchining yangi ismini kiriting:',
        coachStyle:
            '✍️ <b>Yozish uslubingizni tasvirlab bering.</b>\n\n' +
            "AI a'zolarga yozadigan xabarlarni aynan shu uslubda tayyorlaydi.\n\n" +
            '<i>Masalan: "Qisqa yozaman, hurmat bilan lekin qat\'iy. Doim ismini aytaman va ' +
            'oxirida bitta motivatsion jumla qo\'shaman. Emoji kam ishlataman."</i>',
    };
    return prompts[field] ?? 'Qiymatni kiriting:';
}
