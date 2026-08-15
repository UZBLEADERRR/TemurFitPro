import { Telegraf, Markup } from 'telegraf';
import type { Context } from 'telegraf';
import type { Tenant, Member } from '@prisma/client';
import { find as findTz } from 'geo-tz';
import { prisma } from '../core/db';
import { log } from '../core/logger';
import { esc, chunkText, downloadFile, tgError } from '../core/telegram';
import { safeTz, todayIn } from '../core/time';
import { MEAL_LABELS, MEAL_TYPES } from '../core/meals';
import { handleGroupMeal } from '../features/recording';
import { updateGroupTable, renderTable } from '../features/table';
import {
    findInactive, formatInactive, getStats, formatStats,
    findMissingToday, formatMissingToday, listMembers, memberReport,
} from '../features/filters';
import { saveBusinessConnection, connectionSummary } from '../features/business';
import { enqueue } from '../features/outbox';
import { isSuperAdmin, addGroup } from '../core/tenants';
import { ask, aiAvailable, clearHistory } from '../ai/agent';
import type { Role } from '../ai/tools';
import { getState, setState, clearState } from './session';
import { coachMenu, memberMenu, inactiveMenu, statsMenu, settingsMenu, backTo } from './ui';
import crypto from 'crypto';

// Har bir tenant boti uchun handlerlar shu yerda o'rnatiladi.
// tenantId closure orqali beriladi — bir jarayonda N ta bot mustaqil ishlaydi.

export function buildTenantBot(bot: Telegraf, tenantId: string): void {
    const scope = tenantId;

    const loadTenant = async (): Promise<Tenant | null> =>
        prisma.tenant.findUnique({ where: { id: tenantId } });

    // ---------- Guruhga qo'shilganda avtomatik ro'yxatga olish ----------
    bot.on('my_chat_member', async ctx => {
        const upd = ctx.myChatMember;
        const chat = upd.chat;
        if (chat.type !== 'group' && chat.type !== 'supergroup') return;
        const status = upd.new_chat_member.status;

        if (status === 'member' || status === 'administrator') {
            const res = await addGroup(tenantId, String(chat.id), (chat as any).title || '').catch(() => null);
            if (res?.created) {
                log.info('tenant-bot', `yangi guruh ulandi: ${chat.id} (tenant=${tenantId})`);
                await ctx.telegram
                    .sendMessage(
                        chat.id,
                        [
                            '✅ <b>Bot ulandi!</b>',
                            '',
                            "Endi bu guruhda ovqat rasmlarini hashtag bilan yuborishingiz mumkin:",
                            '<code>#nonushta</code> · <code>#tushlik</code> · <code>#kechki</code>',
                            '',
                            "Botni <b>admin</b> qiling — shunda jadvalni pinlay oladi va eslatmalarni tozalaydi.",
                        ].join('\n'),
                        { parse_mode: 'HTML' },
                    )
                    .catch(() => undefined);
            } else {
                await prisma.group.updateMany({
                    where: { tenantId, chatId: String(chat.id) },
                    data: { isActive: true, title: (chat as any).title || '' },
                });
            }
        } else if (status === 'left' || status === 'kicked') {
            await prisma.group.updateMany({
                where: { tenantId, chatId: String(chat.id) },
                data: { isActive: false },
            });
        }
    });

    // ---------- Telegram Business ulanishi ----------
    bot.on('business_connection' as any, async (ctx: any) => {
        const conn = ctx.update?.business_connection;
        if (!conn) return;
        await saveBusinessConnection(tenantId, conn);

        const canReply = conn.rights?.can_reply ?? conn.can_reply ?? false;
        const text = conn.is_enabled
            ? canReply
                ? "✅ <b>Business ulanish faollashdi!</b>\n\nEndi men sizning nomingizdan shaxsiy xabar yubora olaman."
                : "⚠️ <b>Ulandik, lekin javob berish huquqi yo'q.</b>\n\nTelegram → Sozlamalar → Business → Chatbots bo'limida <b>\"Reply to messages\"</b> ni yoqing."
            : "🔌 Business ulanish o'chirildi.";
        await ctx.telegram.sendMessage(conn.user_chat_id, text, { parse_mode: 'HTML' }).catch(() => undefined);
    });

    // ---------- /start ----------
    bot.start(async ctx => {
        if (ctx.chat.type !== 'private') return;
        const tenant = await loadTenant();
        if (!tenant) return;

        const telegramId = String(ctx.from.id);
        const name = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') || 'Foydalanuvchi';

        let member = await prisma.member.findUnique({
            where: { tenantId_telegramId: { tenantId, telegramId } },
        });

        if (!member) {
            // Birinchi kirgan odam — avtomatik EGA (murabbiy) bo'ladi.
            const count = await prisma.member.count({ where: { tenantId } });
            member = await prisma.member.create({
                data: {
                    tenantId,
                    telegramId,
                    name,
                    username: ctx.from.username ?? null,
                    role: count === 0 ? 'owner' : 'member',
                    timezone: tenant.timezone,
                    dmOpen: true,
                },
            });
        } else if (!member.dmOpen) {
            member = await prisma.member.update({ where: { id: member.id }, data: { dmOpen: true } });
        }

        await showMenu(ctx, tenant, member, true);
    });

    bot.command('menu', async ctx => {
        if (ctx.chat.type !== 'private') return;
        const t = await loadTenant();
        const m = await getMember(tenantId, ctx);
        if (t && m) await showMenu(ctx, t, m, false);
    });

    bot.command('id', async ctx => {
        await ctx.reply(`Chat ID: <code>${ctx.chat.id}</code>`, { parse_mode: 'HTML' });
    });

    // ---------- Murabbiy buyruqlari (tugmalarga qo'shimcha) ----------
    bot.command('saralash', async ctx => {
        const guard = await requireCoach(tenantId, ctx);
        if (!guard) return;
        const days = Number((ctx.message as any).text.split(/\s+/)[1]) || 2;
        const rows = await findInactive(guard.tenant, { days });
        await reply(ctx, formatInactive(rows, days), inactiveMenu());
    });

    bot.command('stat', async ctx => {
        const guard = await requireCoach(tenantId, ctx);
        if (!guard) return;
        const days = Number((ctx.message as any).text.split(/\s+/)[1]) || 7;
        await reply(ctx, formatStats(await getStats(guard.tenant, { days })), statsMenu());
    });

    bot.command('bugun', async ctx => {
        const guard = await requireCoach(tenantId, ctx);
        if (!guard) return;
        await reply(ctx, await todayOverview(guard.tenant));
    });

    bot.command('tozalash', async ctx => {
        if (ctx.chat.type !== 'private') return;
        const n = await clearHistory(tenantId, String(ctx.from!.id));
        await ctx.reply(`🧹 AI suhbat tarixi tozalandi (${n} xabar).`);
    });

    // ---------- Callback tugmalar ----------
    bot.on('callback_query', async ctx => {
        const data = (ctx.callbackQuery as any).data as string | undefined;
        if (!data) return;
        await ctx.answerCbQuery().catch(() => undefined);

        const tenant = await loadTenant();
        const member = await getMember(tenantId, ctx);
        if (!tenant || !member) return;

        const isCoachRole = member.role === 'coach' || member.role === 'owner';
        const [ns, action, arg] = data.split(':');

        try {
            if (ns === 'c') {
                if (!isCoachRole && !(await isSuperAdmin(String(ctx.from.id)))) {
                    await ctx.answerCbQuery("Bu bo'lim faqat murabbiy uchun", { show_alert: true }).catch(() => undefined);
                    return;
                }
                await handleCoachAction(ctx, tenant, member, action, arg);
            } else if (ns === 'm') {
                await handleMemberAction(ctx, tenant, member, action, arg);
            }
        } catch (e) {
            log.error('tenant-bot', `callback xatosi (${data})`, e);
            await ctx.reply('⚠️ Xatolik yuz berdi, qaytadan urinib ko\'ring.').catch(() => undefined);
        }
    });

    // ---------- Guruh xabarlari: ovqat qaydi ----------
    bot.on(['photo', 'video'], async ctx => {
        if (ctx.chat.type === 'private') return handlePrivateMedia(ctx);
        const tenant = await loadTenant();
        if (!tenant) return;
        const group = await prisma.group.findUnique({
            where: { tenantId_chatId: { tenantId, chatId: String(ctx.chat.id) } },
        });
        if (!group || !group.isActive) return;
        await handleGroupMeal(ctx, tenant, group).catch(e =>
            log.error('tenant-bot', `ovqat qaydida xato: ${tgError(e)}`),
        );
    });

    // ---------- Ovozli xabar: AI ----------
    bot.on(['voice', 'audio'], async ctx => {
        if (ctx.chat.type !== 'private') return;
        const tenant = await loadTenant();
        const member = await getMember(tenantId, ctx);
        if (!tenant || !member) return;

        if (!aiAvailable(tenant)) {
            await ctx.reply("🤖 AI hali sozlanmagan. Super admin GEMINI_API_KEY ni qo'shishi kerak.");
            return;
        }

        const msg = ctx.message as any;
        const file = msg.voice ?? msg.audio;
        if (!file) return;

        await ctx.sendChatAction('typing').catch(() => undefined);
        try {
            const buffer = await downloadFile(bot, file.file_id);
            const res = await ask({
                tenant,
                actorTgId: String(ctx.from.id),
                actorName: member.name,
                role: await roleOf(tenant, member, String(ctx.from.id)),
                audio: { buffer, mimeType: file.mime_type || 'audio/ogg' },
            });
            const head = res.transcript ? `🎙 <i>${esc(res.transcript)}</i>\n\n` : '';
            await reply(ctx, head + res.reply);
        } catch (e) {
            log.error('tenant-bot', 'ovozli xabar xatosi', e);
            await ctx.reply('🎙 Ovozli xabarni qayta ishlab bo\'lmadi.');
        }
    });

    // ---------- Matnli xabarlar ----------
    bot.on('text', async ctx => {
        if (ctx.chat.type !== 'private') {
            // Guruhda: rasmsiz hashtag ham qabul qilinsa
            const tenant = await loadTenant();
            if (!tenant || tenant.requirePhoto) return;
            const group = await prisma.group.findUnique({
                where: { tenantId_chatId: { tenantId, chatId: String(ctx.chat.id) } },
            });
            if (group?.isActive) await handleGroupMeal(ctx, tenant, group).catch(() => undefined);
            return;
        }

        const tenant = await loadTenant();
        const member = await getMember(tenantId, ctx);
        if (!tenant || !member) return;

        const text = ctx.message.text.trim();
        if (text.startsWith('/')) return;

        const chatId = String(ctx.chat.id);
        const session = await getState(scope, chatId);

        // 1) Sozlama kiritish kutilmoqda
        if (session.state.startsWith('await:')) {
            await handleAwaitedInput(ctx, tenant, session.state.slice(6), text);
            return;
        }

        // 2) Lokatsiya so'ralgan bo'lsa o'tkazib yuboriladi (pastda location handler bor)

        // 3) Qolgan hamma narsa — AI agentga
        if (!aiAvailable(tenant)) {
            await reply(ctx, "🤖 AI hali sozlanmagan.\n\nQuyidagi tugmalardan foydalaning:", 
                (member.role === 'coach' || member.role === 'owner')
                    ? coachMenu(tenantId, tenant.agentName)
                    : memberMenu(tenantId));
            return;
        }

        await ctx.sendChatAction('typing').catch(() => undefined);
        const res = await ask({
            tenant,
            actorTgId: String(ctx.from.id),
            actorName: member.name,
            role: await roleOf(tenant, member, String(ctx.from.id)),
            text,
        });
        await reply(ctx, res.reply);
    });

    // ---------- Lokatsiya: vaqt mintaqasini aniqlash ----------
    bot.on('location', async ctx => {
        if (ctx.chat.type !== 'private') return;
        const member = await getMember(tenantId, ctx);
        if (!member) return;
        const loc = (ctx.message as any).location;
        const zones = findTz(loc.latitude, loc.longitude);
        const timezone = safeTz(zones[0]);
        await prisma.member.update({
            where: { id: member.id },
            data: { latitude: loc.latitude, longitude: loc.longitude, timezone },
        });
        await ctx.reply(
            `✅ Vaqt mintaqangiz aniqlandi: <b>${timezone}</b>\n\nEndi eslatmalar sizning mahalliy vaqtingizda keladi.`,
            { parse_mode: 'HTML', ...Markup.removeKeyboard() },
        );
    });

    // ================= YORDAMCHI FUNKSIYALAR =================

    async function handlePrivateMedia(ctx: Context) {
        await ctx.reply(
            "📸 Ovqat rasmini <b>guruhga</b> yuboring — shaxsiy chatda qayd etilmaydi.\n\n" +
                'Hashtag bilan: <code>#nonushta</code> · <code>#tushlik</code> · <code>#kechki</code>',
            { parse_mode: 'HTML' },
        );
    }

    async function showMenu(ctx: Context, tenant: Tenant, member: Member, greet: boolean) {
        const isCoachRole = member.role === 'coach' || member.role === 'owner';
        const superAdmin = await isSuperAdmin(String(ctx.from!.id));

        if (isCoachRole || superAdmin) {
            const head = greet
                ? `👋 Salom, <b>${esc(member.name)}</b>!\n\nMen <b>${esc(tenant.agentName)}</b> — sizning AI yordamchingizman.\n` +
                  `Menga oddiy tilda yozing yoki ovozli xabar yuboring:\n` +
                  `<i>"oxirgi 2 kunda ovqat yubormaganlarni top"</i>\n` +
                  `<i>"ularga ogohlantirish yubor"</i>\n`
                : `🏋️ <b>Boshqaruv paneli</b>`;
            await reply(ctx, head, coachMenu(tenantId, tenant.agentName));
            return;
        }

        await reply(
            ctx,
            greet
                ? `👋 Salom, <b>${esc(member.name)}</b>!\n\nRatsioningizni guruhga hashtag bilan yuboring:\n` +
                  `<code>#nonushta</code> · <code>#tushlik</code> · <code>#kechki</code>`
                : '📋 <b>Menyu</b>',
            memberMenu(tenantId),
        );
    }

    async function handleCoachAction(ctx: Context, tenant: Tenant, member: Member, action: string, arg?: string) {
        switch (action) {
            case 'menu':
                await reply(ctx, '🏋️ <b>Boshqaruv paneli</b>', coachMenu(tenantId, tenant.agentName));
                return;

            case 'today':
                await reply(ctx, await todayOverview(tenant), backTo('c:menu'));
                return;

            case 'inactive': {
                const days = Number(arg) || 2;
                const rows = await findInactive(tenant, { days });
                await setState(scope, String(ctx.chat!.id), 'idle', { lastInactiveDays: days }, tenantId);
                await reply(ctx, formatInactive(rows, days), inactiveMenu());
                return;
            }

            case 'stats': {
                const days = Number(arg) || 7;
                await reply(ctx, formatStats(await getStats(tenant, { days })), statsMenu());
                return;
            }

            case 'members': {
                const rows = await listMembers(tenant.id);
                const groups = await prisma.group.count({ where: { tenantId, isActive: true } });
                const lines = rows.slice(0, 60).map((r, i) => {
                    const badge = r.role === 'member' ? '' : r.role === 'owner' ? ' 👑' : ' 🎯';
                    return `${i + 1}. ${esc(r.name)}${badge}`;
                });
                await reply(
                    ctx,
                    [`👥 <b>A'zolar: ${rows.length}</b> · Guruhlar: ${groups}`, '', ...lines].join('\n'),
                    backTo('c:menu'),
                );
                return;
            }

            case 'settings':
                await reply(ctx, settingsText(tenant), settingsMenu(tenant));
                return;

            case 'business':
                await reply(ctx, await connectionSummary(tenant.id), backTo('c:menu'));
                return;

            case 'ai':
                await reply(
                    ctx,
                    [
                        `🤖 <b>${esc(tenant.agentName)} bilan suhbat</b>`,
                        '',
                        'Shunchaki yozing yoki ovozli xabar yuboring. Masalan:',
                        `• <i>"oxirgi 3 kunda kechki ovqat yubormaganlarni top"</i>`,
                        `• <i>"ularga ertaga soat 9 da ogohlantirish yubor"</i>`,
                        `• <i>"nonushta vaqtini 07:30 ga o'zgartir"</i>`,
                        `• <i>"eng intizomli 5 kishini ayt"</i>`,
                        '',
                        aiAvailable(tenant) ? '' : "⚠️ AI hali sozlanmagan (GEMINI_API_KEY yo'q).",
                    ].join('\n'),
                    backTo('c:menu'),
                );
                return;

            case 'warn': {
                const st = await getState(scope, String(ctx.chat!.id));
                const days = Number(st.payload.lastInactiveDays) || 2;
                const rows = await findInactive(tenant, { days });
                if (rows.length === 0) {
                    await reply(ctx, '✅ Ogohlantirish kerak bo\'lgan a\'zo yo\'q.', backTo('c:menu'));
                    return;
                }
                await setState(scope, String(ctx.chat!.id), 'await:warnText', { memberIds: rows.map(r => r.id) }, tenantId);
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

            case 'set': {
                if (!arg) return;
                await setState(scope, String(ctx.chat!.id), `await:${arg}`, {}, tenantId);
                await reply(ctx, settingPrompt(arg), backTo('c:settings', '❌ Bekor qilish'));
                return;
            }

            case 'toggle': {
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
    }

    async function handleMemberAction(ctx: Context, tenant: Tenant, member: Member, action: string, _arg?: string) {
        if (action === 'me') {
            const rep = await memberReport(tenant, member.id, 7);
            if (!rep) return;
            const lines = rep.byDate.map(d => {
                const marks = d.meals.map(m => (m.status === 'missing' ? '⚪️' : m.status === 'late' ? '🟡' : '🟢')).join('');
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
            const overrides = await prisma.reminderOverride.findMany({ where: { memberId: member.id, muted: true } });
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
            await reply(ctx, '📋 <b>Menyu</b>', memberMenu(tenantId));
        }
    }

    /// Tugma orqali so'ralgan matnli kiritishni qabul qilish
    async function handleAwaitedInput(ctx: Context, tenant: Tenant, field: string, text: string) {
        const chatId = String(ctx.chat!.id);

        if (field === 'warnText') {
            const st = await getState(scope, chatId);
            const memberIds = (st.payload.memberIds as string[]) ?? [];
            await clearState(scope, chatId);
            if (!memberIds.length) {
                await reply(ctx, "A'zolar ro'yxati eskirgan, qaytadan boshlang.", backTo('c:menu'));
                return;
            }
            const members = await prisma.member.findMany({ where: { id: { in: memberIds } } });
            const batchId = crypto.randomUUID();
            for (const m of members) {
                await enqueue({
                    tenantId,
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

        const timeRe = /^([01]\d|2[0-3]):[0-5]\d$/;
        const data: Record<string, unknown> = {};

        if (['breakfastTime', 'lunchTime', 'dinnerTime'].includes(field)) {
            if (!timeRe.test(text)) {
                await reply(ctx, "❌ Vaqt <code>HH:mm</code> ko'rinishida bo'lsin, masalan <code>08:30</code>.");
                return;
            }
            data[field] = text;
        } else if (field === 'reminderInterval' || field === 'maxReminders') {
            const n = Number(text);
            const max = field === 'reminderInterval' ? 1440 : 20;
            const min = field === 'reminderInterval' ? 5 : 0;
            if (!Number.isFinite(n) || n < min || n > max) {
                await reply(ctx, `❌ ${min}..${max} oralig'ida son kiriting.`);
                return;
            }
            data[field] = Math.round(n);
        } else if (field === 'agentName') {
            data.agentName = text.slice(0, 40);
        } else if (field === 'coachStyle') {
            data.coachStyle = text.slice(0, 2000);
        } else {
            await clearState(scope, chatId);
            return;
        }

        const updated = await prisma.tenant.update({ where: { id: tenantId }, data });
        await clearState(scope, chatId);
        await reply(ctx, '✅ Saqlandi.\n\n' + settingsText(updated), settingsMenu(updated));
    }

    async function todayOverview(tenant: Tenant): Promise<string> {
        const groups = await prisma.group.findMany({ where: { tenantId, isActive: true } });
        if (groups.length === 0) {
            return "📭 Hali guruh ulanmagan.\n\nBotni guruhga qo'shing — u avtomatik ro'yxatga olinadi.";
        }
        const parts: string[] = [];
        for (const g of groups) {
            parts.push(await renderTable(tenant, g));
        }
        const missing = await findMissingToday(tenant, {});
        parts.push(formatMissingToday(missing, 'barcha ovqat'));
        return parts.join('\n\n──────────\n\n');
    }
}

// ================= UMUMIY YORDAMCHILAR =================

async function getMember(tenantId: string, ctx: Context): Promise<Member | null> {
    if (!ctx.from) return null;
    return prisma.member.findUnique({
        where: { tenantId_telegramId: { tenantId, telegramId: String(ctx.from.id) } },
    });
}

async function requireCoach(tenantId: string, ctx: Context): Promise<{ tenant: Tenant; member: Member } | null> {
    if (ctx.chat?.type !== 'private') return null;
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    const member = await getMember(tenantId, ctx);
    if (!tenant || !member) return null;
    const ok = member.role === 'coach' || member.role === 'owner' || (await isSuperAdmin(String(ctx.from!.id)));
    if (!ok) {
        await ctx.reply('Bu buyruq faqat murabbiy uchun.').catch(() => undefined);
        return null;
    }
    return { tenant, member };
}

async function roleOf(tenant: Tenant, member: Member, telegramId: string): Promise<Role> {
    if (await isSuperAdmin(telegramId)) return 'super';
    if (member.role === 'coach' || member.role === 'owner') return 'coach';
    return 'member';
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
                // HTML noto'g'ri bo'lsa — oddiy matn sifatida yuboramiz
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
        `🤖 AI ismi: <b>${esc(t.agentName)}</b>`,
        '',
        t.coachStyle ? `✍️ Yozish uslubi:\n<i>${esc(t.coachStyle.slice(0, 300))}</i>` : "✍️ Yozish uslubi kiritilmagan",
    ].join('\n');
}

function settingPrompt(field: string): string {
    const prompts: Record<string, string> = {
        breakfastTime: "🌅 Nonushta vaqtini kiriting (<code>HH:mm</code>, masalan <code>08:00</code>):",
        lunchTime: "🌞 Tushlik vaqtini kiriting (<code>HH:mm</code>):",
        dinnerTime: "🌙 Kechki ovqat vaqtini kiriting (<code>HH:mm</code>):",
        reminderInterval: "⏱ Eslatmalar orasidagi daqiqani kiriting (5-1440):",
        maxReminders: '🔁 Bir ovqat uchun maksimal eslatma sonini kiriting (0-20):',
        agentName: '🤖 AI yordamchining yangi ismini kiriting:',
        coachStyle:
            "✍️ <b>Yozish uslubingizni tasvirlab bering.</b>\n\n" +
            "AI a'zolarga yozadigan xabarlarni aynan shu uslubda tayyorlaydi.\n\n" +
            '<i>Masalan: "Qisqa yozaman, hurmat bilan lekin qat\'iy. Doim ismini aytaman va ' +
            'oxirida bitta motivatsion jumla qo\'shaman. Emoji kam ishlataman."</i>',
    };
    return prompts[field] ?? 'Qiymatni kiriting:';
}
