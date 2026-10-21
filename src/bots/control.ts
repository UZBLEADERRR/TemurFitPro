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
    purgeGroupData, addGroup, approveGroup, rejectGroup, pendingGroups,
    isSuperAdmin, audit, TenantError, PurgeScope,
    listOrphanMembers, purgeOrphanMembers,
} from '../core/tenants';
import { LIVE_GROUP, IN_LIVE_GROUP, statusBadge } from '../core/groups';
import { getEntry, webhookUrl, tenantSpec, reconcileTenantWebhooks } from '../core/registry';
import { getState } from '../core/webhooks';
import { ask, aiAvailable, aiOffReason } from '../ai/agent';
import { downloadFile } from '../core/telegram';
import { getControlState, setControlState, clearControlState } from './session';
import {
    settings, setGeminiKey, clearGeminiKey, setGeminiModel, setAiEnabled, setPublicUrl,
    maskKey, publicUrl,
} from '../core/settings';
import { encryptionKeySource, secretsFilePath } from '../core/secrets';
import { setBackupEnabled, setBackupHour } from '../core/settings';
import {
    exportTenantFile, parseBackup, importTenant, backupStats, formatRestore,
    BackupError, type RestoreMode,
} from '../features/backup';
import { downloadFile as tgDownload } from '../core/telegram';
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
        // Hali egasi yo'q bo'lsa — birinchi yozgan odam egasi bo'ladi.
        // Shu tufayli Railway'ga SUPER_ADMIN_IDS yozish shart emas.
        if (await claimOwnership(ctx)) return next();

        await ctx
            .reply(`⛔️ Bu bot faqat platforma adminlari uchun.\n\nSizning ID: <code>${ctx.from.id}</code>`, {
                parse_mode: 'HTML',
            })
            .catch(() => undefined);
        return;
    }
    return next();
});

/// Platformaning birinchi egasini belgilash.
///
/// Faqat bazada BITTA HAM super admin bo'lmaganda ishlaydi — ya'ni eng birinchi
/// deploydan keyingi birinchi /start. Shundan keyin bu yo'l butunlay yopiladi.
/// Env'da SUPER_ADMIN_IDS turgan bo'lsa umuman ishlamaydi.
async function claimOwnership(ctx: Context): Promise<boolean> {
    if (env.SUPER_ADMIN_IDS.length) return false;
    if ((await prisma.superAdmin.count()) > 0) return false;

    const tgId = String(ctx.from!.id);
    const name = [ctx.from!.first_name, ctx.from!.last_name].filter(Boolean).join(' ') || tgId;

    try {
        await prisma.superAdmin.create({ data: { telegramId: tgId, name } });
    } catch {
        // Ikki kishi bir vaqtda yozsa — telegramId unique, biri yutqazadi.
        return isSuperAdmin(tgId);
    }

    await audit(null, tgId, 'admin.claim', name);
    log.warn('control-bot', `platforma egasi belgilandi: ${name} (${tgId}) — birinchi /start orqali`);

    await ctx
        .reply(
            [
                "👑 <b>Siz platforma egasi bo'ldingiz.</b>",
                '',
                "Bot hali egasiz edi — birinchi yozgan odam ega bo'ladi.",
                "Endi bu yo'l yopildi: boshqa hech kim shu tarzda kira olmaydi.",
                '',
                `Sizning ID: <code>${tgId}</code>`,
                '',
                "<i>Yana admin qo'shish: 👑 Super adminlar.</i>",
            ].join('\n'),
            { parse_mode: 'HTML' },
        )
        .catch(() => undefined);

    return true;
}

// ---------- Menyular ----------
function mainMenu(pending = 0) {
    return Markup.inlineKeyboard([
        ...(pending > 0
            ? [[Markup.button.callback(`⏳ Tasdiq kutayotgan guruhlar (${pending})`, 's:pending')]]
            : []),
        [Markup.button.callback("➕ Yangi bot qo'shish", 's:addbot')],
        [Markup.button.callback('🤖 Botlar', 's:bots'), Markup.button.callback('📊 Umumiy holat', 's:overview')],
        [Markup.button.callback('👑 Super adminlar', 's:admins')],
        [
            Markup.button.callback('💾 Disk', 's:disk'),
            Markup.button.callback('🔌 Webhook', 's:hooks'),
        ],
        [Markup.button.callback('🔑 Kalitlar', 's:keys')],
        ...(settings().aiEnabled && settings().geminiApiKey
            ? [[Markup.button.callback('🧠 AI bilan boshqarish', 's:ai')]]
            : []),
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
        [Markup.button.callback('💾 Zaxira', `s:backup:${t.id}`), Markup.button.callback("🧹 Tozalash", `s:purge:${t.id}`)],
        [toggle],
        [Markup.button.callback("❌ Botni butunlay o'chirish", `s:del:${t.id}`)],
        [Markup.button.callback('⬅️ Botlar', 's:bots')],
    ]);
}

function purgeMenu(id: string) {
    return Markup.inlineKeyboard([
        [Markup.button.callback('🍽 Ovqat tarixi', `s:pg:${id}:meals`)],
        [Markup.button.callback("👥 A'zolar", `s:pg:${id}:members`)],
        [Markup.button.callback("🧍 Guruhsiz qolgan a'zolar", `s:orph:${id}`)],
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
        await mainMenuWithPending(),
    );
});

controlBot.command('menu', async ctx => showMain(ctx));

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
                return showMain(ctx);

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

            case 'pending':
                return showPending(ctx);

            case 'ai': {
                const tenants = await prisma.tenant.findMany({ where: { status: 'active' }, orderBy: { createdAt: 'asc' } });
                if (!tenants.length) return reply(ctx, "Avval bot qo'shing.", back('s:menu'));
                const rows = tenants.map(t => [Markup.button.callback(`@${t.botUsername}`, `s:aisel:${t.id}`)]);
                rows.push([Markup.button.callback('⬅️ Menyu', 's:menu')]);
                return reply(
                    ctx,
                    "🧠 <b>Qaysi botni boshqaramiz?</b>\n\nTanlang, keyin oddiy tilda buyruq bering yoki ovozli xabar yuboring.",
                    Markup.inlineKeyboard(rows),
                );
            }

            case 'aisel': {
                await setControlState(String(ctx.chat!.id), 'ai', { tenantId: id });
                const t = await prisma.tenant.findUnique({ where: { id } });
                return reply(
                    ctx,
                    [
                        `🧠 <b>AI rejimi: @${esc(t?.botUsername ?? '')}</b>`,
                        '',
                        'Endi yozgan yoki aytgan gapingiz AI ga boradi. Masalan:',
                        '• <i>"3 kunda ovqat yubormaganlarni top va ogohlantirish yubor"</i>',
                        '• <i>"tasdiq kutayotgan guruhlar bormi"</i>',
                        '• <i>"Bekning kechki eslatmasini o\'chir"</i>',
                        '',
                        'Chiqish uchun /menu bosing.',
                    ].join('\n'),
                    back('s:menu', '⬅️ Chiqish'),
                );
            }

            case 'gok': {
                const t = await prisma.tenant.findUnique({ where: { id: id } });
                if (!t) return reply(ctx, 'Bot topilmadi.');
                const g = await approveGroup(t, extra, String(ctx.from.id));
                await reply(ctx, `✅ <b>${esc(g.title || g.chatId)}</b> tasdiqlandi — guruh ishga tushdi.`);
                await announceApproved(t, g.chatId);
                return showPending(ctx);
            }

            case 'gno': {
                const t = await prisma.tenant.findUnique({ where: { id: id } });
                if (!t) return reply(ctx, 'Bot topilmadi.');
                const g = await rejectGroup(t, extra, String(ctx.from.id));
                await reply(ctx, `❌ <b>${esc(g.title || g.chatId)}</b> rad etildi — guruhda hech narsa qayd etilmaydi.`);
                return showPending(ctx);
            }

            case 'gview': {
                return showGroup(ctx, id, extra);
            }

            case 'gpurge':
                return reply(
                    ctx,
                    "⚠️ <b>Tasdiqlang</b>\n\nShu guruhning ovqat tarixi, eslatmalari va FAQAT shu guruhdagi a'zolari o'chiriladi. Boshqa guruhda ham turganlar saqlanadi.",
                    Markup.inlineKeyboard([
                        [Markup.button.callback('✅ Ha, tozala', `s:gpurgeok:${id}:${extra}`)],
                        [Markup.button.callback('❌ Bekor', `s:gview:${id}:${extra}`)],
                    ]),
                );

            case 'gpurgeok': {
                const t = await prisma.tenant.findUnique({ where: { id: id } });
                if (!t) return;
                const summary = await purgeGroupData(t, extra, String(ctx.from.id));
                return reply(ctx, `🧹 Tozalandi: ${esc(summary)}`, back(`s:groups:${id}`));
            }

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

            case 'gcoach':
                return showGroupCoaches(ctx, id, extra!);

            case 'gcoachset': {
                // s:gcoachset:<tenantId>:<groupId>:<memberId>
                const [, , tenantId, groupId, memberId] = data.split(':');
                const t = await prisma.tenant.findUnique({ where: { id: tenantId } });
                if (!t) return showMain(ctx);
                const db = await tenantDb(t.botId);
                const link = await db.groupMember.findUnique({
                    where: { groupId_memberId: { groupId, memberId } },
                    include: { member: true },
                });
                if (!link) return showGroupCoaches(ctx, tenantId, groupId);

                const next = link.role === 'coach' ? 'member' : 'coach';
                await db.groupMember.update({
                    where: { groupId_memberId: { groupId, memberId } },
                    data: { role: next },
                });
                await audit(
                    tenantId,
                    String(ctx.from.id),
                    next === 'coach' ? 'groupcoach.add' : 'groupcoach.remove',
                    `${link.member.name} @ ${groupId}`,
                );
                return showGroupCoaches(ctx, tenantId, groupId);
            }

            case 'orph': {
                const t = await prisma.tenant.findUnique({ where: { id } });
                if (!t) return showMain(ctx);
                const orphans = await listOrphanMembers(t);
                if (!orphans.length) {
                    return reply(
                        ctx,
                        "✅ Guruhsiz qolgan a'zo yo'q — hammasi birorta jonli guruhda.",
                        back(`s:purge:${id}`),
                    );
                }
                const names = orphans.slice(0, 40).map(m => `• ${esc(m.name)}`);
                return reply(
                    ctx,
                    [
                        `🧍 <b>Guruhsiz qolgan a'zolar — ${orphans.length} ta</b>`,
                        '',
                        "Bular o'chirilgan guruhdan qolgan odamlar. Ro'yxatlarda allaqachon",
                        "KO'RINMAYDI, lekin bazada ovqat tarixi bilan yotibdi.",
                        '',
                        ...names,
                        ...(orphans.length > 40 ? [`<i>…va yana ${orphans.length - 40} ta</i>`] : []),
                        '',
                        "<i>O'chirsangiz ularning butun ovqat tarixi ham ketadi.</i>",
                        '<i>Avval 💾 Zaxira olib qo\'ying.</i>',
                    ].join('\n'),
                    Markup.inlineKeyboard([
                        [Markup.button.callback(`🗑 Ha, ${orphans.length} tasini o'chir`, `s:orphok:${id}`)],
                        [Markup.button.callback('⬅️ Bekor', `s:purge:${id}`)],
                    ]),
                );
            }

            case 'orphok': {
                const t = await prisma.tenant.findUnique({ where: { id } });
                if (!t) return showMain(ctx);
                const summary = await purgeOrphanMembers(t, String(ctx.from.id));
                await reply(ctx, `🧹 O'chirildi: ${esc(summary)}`);
                return showGroups(ctx, id);
            }

            case 'backup':
                return showBackup(ctx, id);

            case 'bktoggle':
                await setBackupEnabled(!settings().backupEnabled);
                await audit(null, String(ctx.from.id), 'backup.auto', settings().backupEnabled ? 'on' : 'off');
                return showBackup(ctx, id);

            case 'bkhour': {
                // Soatlarni to'rt qatorda ko'rsatamiz
                const rows: any[][] = [];
                for (let h = 0; h < 24; h += 6) {
                    rows.push(
                        [0, 1, 2, 3, 4, 5].map(i =>
                            Markup.button.callback(
                                `${settings().backupHour === h + i ? '•' : ''}${String(h + i).padStart(2, '0')}`,
                                `s:bksethour:${id}:${h + i}`,
                            ),
                        ),
                    );
                }
                rows.push([Markup.button.callback('⬅️ Orqaga', `s:backup:${id}`)]);
                return reply(ctx, '🕒 <b>Zaxira qaysi soatda ketsin?</b> (UTC)', Markup.inlineKeyboard(rows));
            }

            case 'bksethour':
                await setBackupHour(Number(extra));
                await audit(null, String(ctx.from.id), 'backup.hour', String(extra));
                return showBackup(ctx, id);

            case 'bknow': {
                const t = await prisma.tenant.findUnique({ where: { id } });
                if (!t) return showMain(ctx);
                await reply(ctx, '⏳ Zaxira tayyorlanmoqda...');
                await sendBackup(ctx, t);
                return;
            }

            case 'bkrestore':
                await setControlState(String(ctx.chat!.id), 'await:backupFile', { tenantId: id });
                return reply(
                    ctx,
                    [
                        '♻️ <b>Fayldan tiklash</b>',
                        '',
                        'Zaxira faylini shu yerga <b>hujjat sifatida</b> tashlang',
                        '(<code>.json</code> yoki <code>.json.gz</code>).',
                        '',
                        'Fayl kelgach nima tiklanishini ko\'rsatib, tasdiq so\'rayman.',
                    ].join('\n'),
                    back(`s:backup:${id}`),
                );

            case 'bkgo': {
                // s:bkgo:<tenantId>:<merge|replace>
                const mode = (extra === 'replace' ? 'replace' : 'merge') as RestoreMode;
                const st = await getControlState(String(ctx.chat!.id));
                const fileId = st.payload.fileId as string | undefined;
                if (!fileId) return reply(ctx, "⏳ Fayl eskirdi — qaytadan tashlang.", back(`s:backup:${id}`));

                const t = await prisma.tenant.findUnique({ where: { id } });
                if (!t) return showMain(ctx);

                await clearControlState(String(ctx.chat!.id));
                await reply(ctx, '⏳ Tiklanmoqda...');
                try {
                    const buffer = await tgDownload(controlBot, fileId);
                    const data = parseBackup(buffer);
                    const res = await importTenant(t, data, mode, String(ctx.from.id));
                    await reply(ctx, formatRestore(res), back(`s:backup:${id}`));
                } catch (e) {
                    const msg = e instanceof BackupError ? e.message : String(e).slice(0, 300);
                    await reply(ctx, `❌ Tiklanmadi: ${esc(msg)}`, back(`s:backup:${id}`));
                }
                return;
            }

            case 'keys':
                return showKeys(ctx);

            case 'setgemini':
                await setControlState(String(ctx.chat!.id), 'await:geminiKey');
                return reply(
                    ctx,
                    [
                        '🧠 <b>Gemini kalitini yuboring</b>',
                        '',
                        'Olish: https://aistudio.google.com/apikey (bepul limit bor)',
                        '',
                        "<i>Kalit bazada shifrlangan holda saqlanadi va xabaringiz darhol o'chiriladi.</i>",
                    ].join('\n'),
                    back('s:keys'),
                );

            case 'delgemini':
                await clearGeminiKey();
                await audit(null, String(ctx.from.id), 'settings.gemini.clear');
                return showKeys(ctx);

            case 'setmodel':
                await setControlState(String(ctx.chat!.id), 'await:geminiModel');
                return reply(
                    ctx,
                    [
                        '🤖 <b>Model nomini yuboring</b>',
                        '',
                        `Hozirgi: <code>${esc(settings().geminiModel)}</code>`,
                        '',
                        '<i>Masalan: gemini-3-flash-preview</i>',
                    ].join('\n'),
                    back('s:keys'),
                );

            case 'aitoggle':
                await setAiEnabled(!settings().aiEnabled);
                await audit(null, String(ctx.from.id), 'settings.ai', settings().aiEnabled ? 'on' : 'off');
                return showKeys(ctx);

            case 'setpublic':
                await setControlState(String(ctx.chat!.id), 'await:publicUrl');
                return reply(
                    ctx,
                    [
                        '🌐 <b>Public URL yuboring</b>',
                        '',
                        `Hozirgi: <code>${esc(publicUrl() || "yo'q")}</code>`,
                        '',
                        '<i>Namuna: https://temurfitpro-production.up.railway.app</i>',
                        "<i>Bo'shatish uchun \"-\" yuboring — Railway domeni avtomatik olinadi.</i>",
                    ].join('\n'),
                    back('s:keys'),
                );

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
                if (t) await rejectGroup(t, extra, String(ctx.from.id));
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
                const groups = await db.group.count({ where: LIVE_GROUP });
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

// ---------- Ovozli buyruq ----------
/// Zaxira faylini qabul qilish. Foydalanuvchi faylni "♻️ Fayldan tiklash"
/// bosgandan keyin tashlaydi; darrov tiklamaymiz — avval ichida nima borligini
/// ko'rsatib, tasdiq so'raymiz.
controlBot.on('document', async ctx => {
    const chatId = String(ctx.chat.id);
    const session = await getControlState(chatId);
    const doc = ctx.message.document;

    if (session.state !== 'await:backupFile') {
        await reply(
            ctx,
            "📎 Faylni tiklash uchun avval botni tanlang: 🤖 Botlar → bot → 💾 Zaxira → ♻️ Fayldan tiklash.",
            await mainMenuWithPending(),
        );
        return;
    }

    const tenantId = String(session.payload.tenantId);
    const t = await prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!t) {
        await clearControlState(chatId);
        return showMain(ctx);
    }

    // Telegram bot API 20 MB dan katta faylni yuklab bera olmaydi
    if ((doc.file_size ?? 0) > 20 * 1024 * 1024) {
        return reply(ctx, '❌ Fayl 20 MB dan katta — Telegram uni botga bermaydi.', back(`s:backup:${tenantId}`));
    }

    await ctx.sendChatAction('typing').catch(() => undefined);

    try {
        const buffer = await tgDownload(controlBot, doc.file_id);
        const data = parseBackup(buffer);
        const st = backupStats(data);

        const mismatch =
            data.botId && data.botId !== t.botId
                ? `\n⚠️ <b>Diqqat:</b> bu fayl BOSHQA botniki (@${esc(data.botUsername || data.botId)}).\n`
                : '';

        await setControlState(chatId, 'await:backupConfirm', { tenantId, fileId: doc.file_id });

        await reply(
            ctx,
            [
                '📦 <b>Fayl o\'qildi</b>',
                `<code>${esc(doc.file_name || 'zaxira')}</code>`,
                data.exportedAt ? `🕒 Olingan: ${esc(data.exportedAt.slice(0, 16).replace('T', ' '))}` : '',
                mismatch,
                'Ichida:',
                `🏠 ${st.groups} guruh · 👥 ${st.members} a'zo`,
                `🔗 ${st.links} guruh a'zoligi · 🍽 ${st.meals} ovqat qaydi`,
                '',
                `Qaysi usulda tiklay? Bot: <b>@${esc(t.botUsername)}</b>`,
                '',
                "➕ <b>Qo'shib tiklash</b> — hech narsa o'chmaydi. Yo'q yozuvlar qo'shiladi,",
                'bor yozuvlar joyida qoladi. <b>Odatda shu kerak.</b>',
                '',
                "🔄 <b>To'liq almashtirish</b> — botning hozirgi hamma ma'lumoti O'CHADI",
                'va faqat fayldagisi qoladi.',
            ]
                .filter(Boolean)
                .join('\n'),
            Markup.inlineKeyboard([
                [Markup.button.callback("➕ Qo'shib tiklash", `s:bkgo:${tenantId}:merge`)],
                [Markup.button.callback("🔄 To'liq almashtirish", `s:bkgo:${tenantId}:replace`)],
                [Markup.button.callback('❌ Bekor', `s:backup:${tenantId}`)],
            ]),
        );
    } catch (e) {
        const msg = e instanceof BackupError ? e.message : String(e).slice(0, 300);
        await reply(ctx, `❌ ${esc(msg)}`, back(`s:backup:${tenantId}`));
    }
});

controlBot.on(['voice', 'audio'], async ctx => {
    const session = await getControlState(String(ctx.chat.id));
    if (session.state !== 'ai') {
        return reply(ctx, "🎙 Ovozli buyruq uchun avval <b>🧠 AI bilan boshqarish</b> dan botni tanlang.", await mainMenuWithPending());
    }
    const tenant = await prisma.tenant.findUnique({ where: { id: String(session.payload.tenantId) } });
    if (!tenant) return showMain(ctx);
    if (!aiAvailable(tenant)) return reply(ctx, aiOffReason(tenant));

    const file = (ctx.message as any).voice ?? (ctx.message as any).audio;
    if (!file) return;
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
        await reply(ctx, "🎙 Ovozni qayta ishlab bo'lmadi.");
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
            if (!t) return showMain(ctx);
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
            if (!t) return showMain(ctx);
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

        case 'await:geminiKey': {
            await clearControlState(chatId);
            // Kalit chatda qolib ketmasin
            await ctx.deleteMessage().catch(() => undefined);
            if (text.length < 20) return reply(ctx, "❌ Bu kalitga o'xshamadi.", back('s:keys'));
            await setGeminiKey(text);
            await audit(null, String(ctx.from.id), 'settings.gemini.set');
            await reply(ctx, "✅ Gemini kaliti saqlandi (xabaringiz o'chirildi).");
            return showKeys(ctx);
        }

        case 'await:geminiModel': {
            await clearControlState(chatId);
            if (!/^[a-z0-9.\-]{3,60}$/i.test(text)) return reply(ctx, '❌ Model nomi xato.', back('s:keys'));
            await setGeminiModel(text);
            await audit(null, String(ctx.from.id), 'settings.model', text);
            return showKeys(ctx);
        }

        case 'await:publicUrl': {
            await clearControlState(chatId);
            if (text === '-') {
                await setPublicUrl('');
                await audit(null, String(ctx.from.id), 'settings.publicUrl.clear');
                return showKeys(ctx);
            }
            if (!/^https:\/\/[^\s/]+/.test(text)) {
                return reply(ctx, '❌ https:// bilan boshlanishi kerak.', back('s:keys'));
            }
            await setPublicUrl(text);
            await audit(null, String(ctx.from.id), 'settings.publicUrl', text);
            // Yangi manzilga webhooklarni ko'chiramiz
            const { reconcileControlWebhook } = await import('../index');
            await reconcileControlWebhook().catch(() => undefined);
            await reconcileTenantWebhooks().catch(() => undefined);
            await reply(ctx, "✅ Public URL saqlandi, webhooklar yangi manzilga ko'chirildi.");
            return showKeys(ctx);
        }

        case 'ai': {
            const tenant = await prisma.tenant.findUnique({ where: { id: String(session.payload.tenantId) } });
            if (!tenant) return showMain(ctx);
            if (!aiAvailable(tenant)) return reply(ctx, aiOffReason(tenant), await mainMenuWithPending());
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
            return showMain(ctx, 'Menyudan tanlang 👇');
    }
});

// ---------- Ko'rinishlar ----------

async function doAddBot(ctx: Context, token: string) {
    try {
        const tenant = await createTenant(token, String(ctx.from!.id));
        const hookNote = publicUrl()
            ? `Webhook: <code>${esc(webhookUrl(tenant))}</code>`
            : "⚠️ <b>Public URL topilmadi</b> — webhook o'rnatilmadi (🔑 Kalitlar → 🌐).";
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
        db.group.count({ where: LIVE_GROUP }),
        db.member.count({ where: { status: 'active', ...IN_LIVE_GROUP } }),
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
    const groups = await db.group.findMany({
        where: { status: { not: 'rejected' } },
        orderBy: [{ status: 'asc' }, { createdAt: 'asc' }],
    });

    const rows = await Promise.all(
        groups.map(async g => {
            const n = await db.groupMember.count({ where: { groupId: g.id } });
            const mark = !g.isActive ? '🚪' : g.status === 'approved' ? '🏠' : '⏳';
            return [
                Markup.button.callback(
                    `${mark} ${(g.title || g.chatId).slice(0, 24)} (${n})`,
                    `s:gview:${tenantId}:${g.id}`,
                ),
            ];
        }),
    );
    rows.push([Markup.button.callback("➕ Guruh qo'shish", `s:addgroup:${tenantId}`)]);
    rows.push([Markup.button.callback('⬅️ Orqaga', `s:bot:${tenantId}`)]);

    const waiting = groups.filter(g => g.isActive && g.status === 'pending').length;

    return reply(
        ctx,
        groups.length
            ? [
                  `🏠 <b>Guruhlar (${groups.length})</b>`,
                  waiting ? `⏳ ${waiting} tasi tasdiq kutmoqda` : '',
                  '',
                  '🏠 faol · ⏳ tasdiq kutmoqda · 🚪 bot chiqarilgan',
              ]
                  .filter(Boolean)
                  .join('\n')
            : "🏠 Hali guruh yo'q.\n\n<i>Botni guruhga qo'shsangiz bu yerda tasdiq so'raladi.</i>",
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
        groups += await db.group.count({ where: LIVE_GROUP });
        members += await db.member.count({ where: { status: 'active', ...IN_LIVE_GROUP } });
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
            `🌐 Public URL: ${publicUrl() ? '✅' : '❌ topilmadi'}`,
            `🧠 AI: ${!settings().aiEnabled ? "⏸ o'chirilgan" : settings().geminiApiKey ? `✅ ${settings().geminiModel}` : "❌ kalit yo'q"}`,
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
    if (!publicUrl()) {
        return reply(
            ctx,
            "⚠️ <b>Public URL topilmadi</b>\n\nWebhooklar o'rnatilmaydi va botlar hech qanday xabar olmaydi.\n\nRailway → Settings → Networking → <b>Generate Domain</b> bosing (keyin qayta deploy),\nyoki 🔑 Kalitlar → 🌐 Public URL dan qo'lda kiriting.",
            Markup.inlineKeyboard([[Markup.button.callback('🌐 Public URL kiritish', 's:setpublic')], [Markup.button.callback('⬅️ Orqaga', 's:menu')]]),
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

async function showMain(ctx: Context, title = '👑 <b>Boshqaruv markazi</b>') {
    return reply(ctx, title, await mainMenuWithPending());
}

async function mainMenuWithPending() {
    const pending = await pendingGroups().catch(() => []);
    return mainMenu(pending.length);
}

/// Tasdiq kutayotgan guruhlar — barcha botlar bo'ylab
async function showPending(ctx: Context) {
    const rows = await pendingGroups();
    if (rows.length === 0) {
        return reply(ctx, "✅ Tasdiq kutayotgan guruh yo'q.", back('s:menu'));
    }

    const first = rows[0];
    const lines = [
        `⏳ <b>Tasdiq kutmoqda: ${rows.length}</b>`,
        '',
        `🤖 Bot: @${esc(first.tenant.botUsername)}`,
        `🏠 Guruh: <b>${esc(first.group.title || '(nomsiz)')}</b>`,
        `🆔 <code>${first.group.chatId}</code>`,
        `📅 ${formatIn(first.group.createdAt, safeTz(first.tenant.timezone), 'dd.MM.yyyy HH:mm')}`,
    ];
    if (rows.length > 1) lines.push('', `<i>Bu birinchisi — qolgan ${rows.length - 1} tasi navbatda.</i>`);

    return reply(
        ctx,
        lines.join('\n'),
        Markup.inlineKeyboard([
            [
                Markup.button.callback('✅ Tasdiqlash', `s:gok:${first.tenant.id}:${first.group.id}`),
                Markup.button.callback('❌ Rad etish', `s:gno:${first.tenant.id}:${first.group.id}`),
            ],
            [Markup.button.callback('⬅️ Menyu', 's:menu')],
        ]),
    );
}

/// Tasdiqlangач guruhga xabar berish
async function announceApproved(tenant: Tenant, chatId: string) {
    const entry = getEntry(tenant.botId);
    if (!entry) return;
    await entry.bot.telegram
        .sendMessage(
            chatId,
            [
                '✅ <b>Bot ishga tushdi!</b>',
                '',
                'Ovqat rasmini hashtag bilan yuboring:',
                '<code>#nonushta</code> · <code>#tushlik</code> · <code>#kechki</code>',
                '',
                'Botni <b>admin</b> qiling — shunda jadvalni pinlay oladi va eslatmalarni tozalaydi.',
            ].join('\n'),
            { parse_mode: 'HTML' },
        )
        .catch(e => log.warn('control-bot', `guruhga xabar yetmadi: ${tgError(e)}`));
}

/// Bitta guruh — super admin uchun to'liq boshqaruv
async function showGroup(ctx: Context, tenantId: string, groupId: string) {
    const t = await prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!t) return;
    const db = await tenantDb(t.botId);
    const g = await db.group.findUnique({ where: { id: groupId } });
    if (!g) return showGroups(ctx, tenantId);

    const [people, meals] = await Promise.all([
        db.groupMember.count({ where: { groupId: g.id } }),
        db.mealRecord.count({ where: { groupId: g.id } }),
    ]);

    const actions: any[][] = [];
    if (g.status !== 'approved') {
        actions.push([Markup.button.callback('✅ Tasdiqlash', `s:gok:${tenantId}:${g.id}`)]);
    } else {
        actions.push([Markup.button.callback('⛔️ Faoliyatini to\'xtatish', `s:gno:${tenantId}:${g.id}`)]);
    }
    actions.push([Markup.button.callback('🎯 Shu guruh murabbiysi', `s:gcoach:${tenantId}:${g.id}`)]);
    actions.push([Markup.button.callback("🧹 Ma'lumotlarini tozalash", `s:gpurge:${tenantId}:${g.id}`)]);
    actions.push([Markup.button.callback('⬅️ Guruhlar', `s:groups:${tenantId}`)]);

    const coaches = await db.groupMember.findMany({
        where: { groupId: g.id, role: 'coach' },
        include: { member: true },
    });

    return reply(
        ctx,
        [
            `🏠 <b>${esc(g.title || g.chatId)}</b>`,
            `<code>${g.chatId}</code>`,
            statusBadge(g),
            '',
            `👥 A'zolar: <b>${people}</b>`,
            `🍽 Ovqat qaydlari: <b>${meals}</b>`,
            `🎯 Murabbiy: ${coaches.length ? coaches.map(c => `<b>${esc(c.member.name)}</b>`).join(', ') : '<i>tayinlanmagan</i>'}`,
        ].join('\n'),
        Markup.inlineKeyboard(actions),
    );
}

/// Shu GURUHNING murabbiylari. Global murabbiydan farqi: bu odam faqat shu
/// guruhni ko'radi. Har bir guruhga alohida murabbiy tayinlash uchun.
async function showGroupCoaches(ctx: Context, tenantId: string, groupId: string) {
    const t = await prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!t) return;
    const db = await tenantDb(t.botId);
    const g = await db.group.findUnique({ where: { id: groupId } });
    if (!g) return showGroups(ctx, tenantId);

    const links = await db.groupMember.findMany({
        where: { groupId },
        include: { member: true },
        orderBy: { joinedAt: 'asc' },
    });

    const coaches = links.filter(l => l.role === 'coach');

    // Guruhdagi har bir a'zoni bosib murabbiy qilish/olib tashlash mumkin
    const rows = links.slice(0, 60).map(l => [
        Markup.button.callback(
            `${l.role === 'coach' ? '🎯' : '👤'} ${l.member.name.slice(0, 28)}`,
            `s:gcoachset:${tenantId}:${groupId}:${l.memberId}`,
        ),
    ]);
    rows.push([Markup.button.callback('⬅️ Guruh', `s:gview:${tenantId}:${groupId}`)]);

    return reply(
        ctx,
        [
            `🎯 <b>Guruh murabbiysi</b>`,
            `🏠 ${esc(g.title || g.chatId)}`,
            '',
            coaches.length
                ? `Hozir: ${coaches.map(c => `<b>${esc(c.member.name)}</b>`).join(', ')}`
                : '<i>Hali tayinlanmagan.</i>',
            '',
            "Ismga bosing — murabbiylik <b>shu guruh uchun</b> qo'shiladi yoki olinadi.",
            '',
            "<i>Guruh murabbiysi faqat SHU guruhning a'zolarini, jadvalini va",
            "statistikasini ko'radi. Boshqa guruhlar unga ko'rinmaydi.</i>",
            '',
            "<i>Botning barcha guruhlarini ko'radigan murabbiy kerak bo'lsa —",
            'bot menyusidagi 🎯 Murabbiylar dan tayinlang.</i>',
        ].join('\n'),
        Markup.inlineKeyboard(rows),
    );
}

/// Bot uchun zaxira ekrani
async function showBackup(ctx: Context, tenantId: string) {
    const t = await prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!t) return;

    return reply(
        ctx,
        [
            `💾 <b>Zaxira</b> — @${esc(t.botUsername)}`,
            '',
            settings().backupEnabled
                ? `✅ Har kuni <b>${String(settings().backupHour).padStart(2, '0')}:00 UTC</b> da super adminlarga yuboriladi.`
                : "⏸ Avtomatik yuborish o'chirilgan.",
            '',
            "Faylda: guruhlar, a'zolar, kim qaysi guruhda, butun ovqat tarixi va bot sozlamalari.",
            '',
            "Biror guruhning ma'lumoti yo'qolsa — o'sha faylni shu yerga tashlang,",
            'hammasi qaytadi.',
            '',
            '<i>Faylda bot tokeni va maxfiy kalitlar YO\'Q — u oddiy chatda yotishi xavfsiz.</i>',
        ].join('\n'),
        Markup.inlineKeyboard([
            [Markup.button.callback('📤 Hozir yuborish', `s:bknow:${tenantId}`)],
            [Markup.button.callback('♻️ Fayldan tiklash', `s:bkrestore:${tenantId}`)],
            [
                Markup.button.callback(
                    settings().backupEnabled ? '⏸ Avtomatikni o\'chirish' : '▶️ Avtomatikni yoqish',
                    `s:bktoggle:${tenantId}`,
                ),
                Markup.button.callback('🕒 Soat', `s:bkhour:${tenantId}`),
            ],
            [Markup.button.callback('⬅️ Orqaga', `s:bot:${tenantId}`)],
        ]),
    );
}

/// 🔑 Kalitlar — Railway'da env o'zgaruvchisi kovlab o'tirmaslik uchun.
/// Bu yerdan hamma narsani bot ichidan qo'yish mumkin.
async function showKeys(ctx: Context) {
    const st = settings();
    const src = encryptionKeySource();
    const admins = await prisma.superAdmin.count();

    const encLine =
        src === 'env'
            ? "✅ env'dan olindi va faylga ko'chirildi"
            : src === 'yangi'
              ? '🆕 endi yaratildi'
              : "✅ faylda (o'zgarmaydi)";

    const geminiLine = st.geminiApiKey
        ? `✅ <code>${esc(maskKey(st.geminiApiKey))}</code> · ${st.geminiKeyFromBot ? 'bot ichidan' : "Railway env'dan"}`
        : "❌ yo'q";

    const urlLine = publicUrl()
        ? `✅ <code>${esc(publicUrl())}</code> · ${st.publicUrlFromBot ? "qo'lda" : 'avtomatik'}`
        : '❌ topilmadi';

    const rows = [
        [Markup.button.callback(st.geminiApiKey ? '🧠 Gemini kalitini almashtirish' : "🧠 Gemini kalitini qo'yish", 's:setgemini')],
        ...(st.geminiKeyFromBot ? [[Markup.button.callback("🗑 Gemini kalitini o'chirish", 's:delgemini')]] : []),
        [
            Markup.button.callback('🤖 Model', 's:setmodel'),
            Markup.button.callback(st.aiEnabled ? "⚡ AI: yoqilgan" : '⚡ AI: o\'chirilgan', 's:aitoggle'),
        ],
        [Markup.button.callback('🌐 Public URL', 's:setpublic')],
        [Markup.button.callback('⬅️ Menyu', 's:menu')],
    ];

    return reply(
        ctx,
        [
            '🔑 <b>Kalitlar va sozlamalar</b>',
            '',
            '<b>Railway env</b> — faqat ikkitasi kerak:',
            '• <code>CONTROL_BOT_TOKEN</code> ✅ (ishlab turibdi)',
            `• <code>GEMINI_API_KEY</code> ${st.geminiApiKey && !st.geminiKeyFromBot ? '✅' : '— shart emas, quyidan qo\'ying'}`,
            '',
            '<b>O\'zi sozlanadiganlar</b>',
            `🔐 Shifrlash kaliti: ${encLine}`,
            `🔌 Webhook siri: ✅ avtomatik`,
            `👑 Adminlar: ${admins} ta · ${env.SUPER_ADMIN_IDS.length ? "env'da belgilangan" : 'birinchi /start orqali olingan'}`,
            '',
            '<b>Bu yerdan o\'zgartiriladi</b>',
            `🧠 Gemini kaliti: ${geminiLine}`,
            `🤖 Model: <code>${esc(st.geminiModel)}</code>`,
            `⚡ AI: ${st.aiEnabled ? 'yoqilgan' : "o'chirilgan"}`,
            `🌐 Public URL: ${urlLine}`,
            '',
            `<i>Maxfiy qiymatlar shifrlangan. Kalit fayli: <code>${esc(secretsFilePath())}</code></i>`,
        ].join('\n'),
        Markup.inlineKeyboard(rows),
    );
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

/// Zaxira faylini shu chatga yuborish
async function sendBackup(ctx: Context, t: Tenant): Promise<void> {
    try {
        const { buffer, filename, stats } = await exportTenantFile(t);
        await controlBot.telegram.sendDocument(
            ctx.chat!.id,
            { source: buffer, filename },
            {
                caption: [
                    `💾 <b>Zaxira</b> — @${esc(t.botUsername)}`,
                    `🏠 ${stats.groups} guruh · 👥 ${stats.members} a'zo · 🍽 ${stats.meals} qayd`,
                    '',
                    "<i>Ma'lumot yo'qolsa shu faylni botga qaytarib tashlang.</i>",
                ].join('\n'),
                parse_mode: 'HTML',
            },
        );
    } catch (e) {
        log.error('backup', `zaxira yuborilmadi (${t.botId})`, e);
        await reply(ctx, `❌ Zaxira yuborilmadi: ${esc(tgError(e))}`, back(`s:backup:${t.id}`));
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
        log.info('control-bot', "hali egasi yo'q — ona botga birinchi /start bosgan odam ega bo'ladi");
    }
}
