import type { Tenant } from '../generated/platform';
import type { TenantClient } from '../core/db';
import { prisma, tenantDb } from '../core/db';
import type { FunctionDeclaration } from './gemini';
import type { Role } from '../core/roles';
import {
    listGroups, listMembers, findInactive, findMissingToday, getStats, memberReport, searchMembers,
} from '../features/filters';
import { enqueue, recordSend, pendingSummary, cancelPending, listFailed } from '../features/outbox';
import { activeConnection } from '../features/business';
import { deliverToMember, describeAttempts, CHANNEL_LABEL, type Channel } from '../features/delivery';
import { updateGroupTable } from '../features/table';
import {
    purgeTenantData, pauseTenant, resumeTenant, addGroup, approveGroup, rejectGroup,
    pendingGroups, findTenantByHint, audit, PurgeScope,
} from '../core/tenants';
import { LIVE_GROUP } from '../core/groups';
import { getBotByTenant } from '../core/registry';
import { MEAL_TYPES, MEAL_LABELS, isMealType, MealType } from '../core/meals';
import { safeTz, localDateTimeToUtc, formatIn } from '../core/time';
import { esc, tgError } from '../core/telegram';
import { log } from '../core/logger';

export interface ToolContext {
    tenant: Tenant;
    /// Shu botning o'z ma'lumot fayli
    db: TenantClient;
    actorTgId: string;
    role: Role;
    /// Bitta buyruq bilan yuborilgan xabarlarni kuzatish uchun
    batchId: string;
}

interface ToolDef {
    decl: FunctionDeclaration;
    roles: Role[];
    run: (args: any, ctx: ToolContext) => Promise<unknown>;
}

/// AI javobi cho'zilib ketmasin — bundan ortig'i navbatga tushadi
const IMMEDIATE_LIMIT = 20;

const S = (d: string) => ({ type: 'string', description: d });
const N = (d: string) => ({ type: 'number', description: d });
const B = (d: string) => ({ type: 'boolean', description: d });

// ---------- yordamchilar ----------

async function resolveGroupId(db: TenantClient, hint?: string): Promise<string | null> {
    if (!hint || /^(all|hammasi|barchasi)$/i.test(hint)) return null;
    const groups = await db.group.findMany({ where: LIVE_GROUP });
    const lower = hint.toLowerCase();
    return (
        groups.find(g => g.id === hint) ??
        groups.find(g => g.chatId === hint) ??
        groups.find(g => (g.title || '').toLowerCase().includes(lower))
    )?.id ?? null;
}

async function resolveMembers(db: TenantClient, queries: string[]) {
    const found: any[] = [];
    const missing: string[] = [];
    for (const q of queries) {
        const direct = await db.member.findFirst({ where: { OR: [{ id: q }, { telegramId: q }] } });
        if (direct) {
            found.push(direct);
            continue;
        }
        const hits = await searchMembers(db, q);
        if (hits.length === 1) {
            const m = await db.member.findUnique({ where: { id: hits[0].id } });
            if (m) found.push(m);
        } else if (hits.length > 1) {
            missing.push(`${q} (${hits.length} ta moslik: ${hits.map(h => h.name).join(', ')})`);
        } else {
            missing.push(q);
        }
    }
    return { found, missing };
}

function normalizeMeal(v?: string): MealType | 'any' {
    if (!v) return 'any';
    const s = v.toLowerCase();
    if (isMealType(s)) return s;
    if (s.startsWith('non') || s.includes('breakfast') || s.includes('завтрак')) return 'nonushta';
    if (s.startsWith('tush') || s.includes('lunch') || s.includes('abed') || s.includes('обед')) return 'tushlik';
    if (s.startsWith('kech') || s.includes('dinner') || s.includes('ужин')) return 'kechki';
    return 'any';
}

// ---------- TOOL'LAR ----------

const TOOLS: Record<string, ToolDef> = {
    list_groups: {
        roles: ['super', 'coach'],
        decl: {
            name: 'list_groups',
            description: "Shu botga ulangan va tasdiqlangan guruhlar ro'yxati.",
            parameters: { type: 'object', properties: {} },
        },
        run: async (_a, ctx) => {
            const groups = await listGroups(ctx.db);
            return Promise.all(
                groups.map(async g => ({
                    id: g.id,
                    title: g.title || '(nomsiz)',
                    chat_id: g.chatId,
                    members: await ctx.db.groupMember.count({ where: { groupId: g.id } }),
                })),
            );
        },
    },

    list_members: {
        roles: ['super', 'coach'],
        decl: {
            name: 'list_members',
            description: "A'zolar ro'yxati. Guruh yoki rol bo'yicha filtrlash mumkin.",
            parameters: {
                type: 'object',
                properties: {
                    group: S("Guruh nomi/id yoki 'all' (standart — barcha guruhlar)"),
                    role: S('member | coach | owner'),
                },
            },
        },
        run: async (a, ctx) => {
            const rows = await listMembers(ctx.db, {
                groupId: await resolveGroupId(ctx.db, a.group),
                role: a.role,
            });
            return { count: rows.length, members: rows.map(r => ({ id: r.id, name: r.name, role: r.role, groups: r.groups })) };
        },
    },

    find_inactive: {
        roles: ['super', 'coach'],
        decl: {
            name: 'find_inactive',
            description:
                "N kun KETMA-KET ovqat yubormagan a'zolarni topadi — murabbiyning eng ko'p ishlatadigan so'rovi. " +
                "meal_type berilsa aynan o'sha vaqtdagi ovqat (masalan 2 kun ketma-ket nonushta rasmi) hisobga olinadi. " +
                "Bugun yuborgan odam ro'yxatga kirmaydi.",
            parameters: {
                type: 'object',
                properties: {
                    days: N('Necha kun (standart 2)'),
                    meal_type: S('nonushta | tushlik | kechki | any'),
                    group: S("Guruh nomi/id yoki 'all'"),
                },
                required: ['days'],
            },
        },
        run: async (a, ctx) => {
            const rows = await findInactive(ctx.db, ctx.tenant, {
                days: Number(a.days) || 2,
                mealType: normalizeMeal(a.meal_type),
                groupId: await resolveGroupId(ctx.db, a.group),
            });
            return {
                days: Number(a.days) || 2,
                count: rows.length,
                members: rows.map(r => ({
                    id: r.id,
                    name: r.name,
                    last_meal_date: r.lastMealDate,
                    days_since: r.daysSince,
                    groups: r.groups,
                })),
            };
        },
    },

    find_missing_today: {
        roles: ['super', 'coach'],
        decl: {
            name: 'find_missing_today',
            description: "Bugun (a'zoning o'z vaqt mintaqasida) hali ovqat yubormaganlar.",
            parameters: {
                type: 'object',
                properties: { meal_type: S('nonushta | tushlik | kechki | any'), group: S("Guruh nomi/id yoki 'all'") },
            },
        },
        run: async (a, ctx) => {
            const rows = await findMissingToday(ctx.db, {
                mealType: normalizeMeal(a.meal_type),
                groupId: await resolveGroupId(ctx.db, a.group),
            });
            return {
                count: rows.length,
                members: rows.map(r => ({
                    id: r.id,
                    name: r.name,
                    groups: r.groups,
                    missing: r.missing.map(m => MEAL_LABELS[m]),
                })),
            };
        },
    },

    get_stats: {
        roles: ['super', 'coach'],
        decl: {
            name: 'get_stats',
            description: 'Intizom statistikasi: bajarilish foizi, kechikishlar.',
            parameters: { type: 'object', properties: { days: N('Kun (standart 7)'), group: S("Guruh yoki 'all'") } },
        },
        run: async (a, ctx) => {
            const res = await getStats(ctx.db, ctx.tenant, {
                days: Number(a.days) || 7,
                groupId: await resolveGroupId(ctx.db, a.group),
            });
            return {
                period: `${res.from} … ${res.to}`,
                days: res.days,
                members: res.rows.map(r => ({ name: r.name, rate: r.rate, done: r.done, missed: r.missed, late: r.late })),
                average: res.rows.length ? Math.round(res.rows.reduce((s, r) => s + r.rate, 0) / res.rows.length) : 0,
            };
        },
    },

    member_report: {
        roles: ['super', 'coach'],
        decl: {
            name: 'member_report',
            description: "Bitta a'zoning kunma-kun hisoboti.",
            parameters: {
                type: 'object',
                properties: { member: S("A'zo ismi, username yoki id"), days: N('Kun (standart 7)') },
                required: ['member'],
            },
        },
        run: async (a, ctx) => {
            const { found, missing } = await resolveMembers(ctx.db, [String(a.member)]);
            if (!found.length) return { error: `A'zo topilmadi: ${missing.join(', ')}` };
            const rep = await memberReport(ctx.db, found[0].id, Number(a.days) || 7);
            if (!rep) return { error: 'Hisobot tuzilmadi' };
            return {
                name: rep.member.name,
                total: rep.total,
                expected: rep.expected,
                days: rep.byDate.map(d => ({
                    date: d.date,
                    meals: d.meals.map(m => `${MEAL_LABELS[m.meal]}: ${m.status}${m.at ? ` (${m.at})` : ''}`),
                })),
            };
        },
    },

    search_members: {
        roles: ['super', 'coach'],
        decl: {
            name: 'search_members',
            description: "A'zolarni ism/username bo'yicha izlash.",
            parameters: { type: 'object', properties: { query: S('Qidiruv matni') }, required: ['query'] },
        },
        run: async (a, ctx) => {
            const rows = await searchMembers(ctx.db, String(a.query));
            return { count: rows.length, members: rows.map(r => ({ id: r.id, name: r.name, username: r.username, role: r.role })) };
        },
    },

    get_settings: {
        roles: ['super', 'coach'],
        decl: {
            name: 'get_settings',
            description: 'Botning joriy sozlamalari.',
            parameters: { type: 'object', properties: {} },
        },
        run: async (_a, ctx) => {
            const t = ctx.tenant;
            return {
                agent_name: t.agentName,
                coach_style: t.coachStyle || '(kiritilmagan)',
                timezone: t.timezone,
                breakfast_time: t.breakfastTime,
                lunch_time: t.lunchTime,
                dinner_time: t.dinnerTime,
                grace_minutes: t.graceMinutes,
                reminder_interval: t.reminderInterval,
                max_reminders: t.maxReminders,
                daily_table_hour: t.dailyTableHour,
                require_photo: t.requirePhoto,
                breakfast_words: t.breakfastWords,
                lunch_words: t.lunchWords,
                dinner_words: t.dinnerWords,
            };
        },
    },

    get_reminder_settings: {
        roles: ['super', 'coach'],
        decl: {
            name: 'get_reminder_settings',
            description: "Kimning qaysi ovqat bo'yicha eslatmasi o'chirilganini ko'rsatadi.",
            parameters: { type: 'object', properties: { member: S("A'zo ismi. Bo'sh — hammasi.") } },
        },
        run: async (a, ctx) => {
            if (a.member) {
                const { found } = await resolveMembers(ctx.db, [String(a.member)]);
                if (!found.length) return { error: "A'zo topilmadi" };
                const ov = await ctx.db.reminderOverride.findMany({ where: { memberId: found[0].id, muted: true } });
                return {
                    member: found[0].name,
                    muted: ov.map(o => MEAL_LABELS[o.mealType as MealType] ?? o.mealType),
                };
            }
            const all = await ctx.db.reminderOverride.findMany({ where: { muted: true }, include: { member: true } });
            return {
                count: all.length,
                muted: all.map(o => ({ member: o.member.name, meal: MEAL_LABELS[o.mealType as MealType] ?? o.mealType })),
            };
        },
    },

    business_status: {
        roles: ['super', 'coach'],
        decl: {
            name: 'business_status',
            description: 'Telegram Business ulanishi — murabbiy nomidan xabar yuborish mumkinmi.',
            parameters: { type: 'object', properties: {} },
        },
        run: async (_a, ctx) => {
            const conn = await activeConnection(ctx.db, ctx.actorTgId);
            return {
                ready: !!conn,
                connection: conn ? { user: conn.userName, can_reply: conn.canReply } : null,
                hint: conn ? null : 'Telegram → Sozlamalar → Business → Chatbots orqali botni ulash kerak.',
            };
        },
    },

    list_scheduled_messages: {
        roles: ['super', 'coach'],
        decl: {
            name: 'list_scheduled_messages',
            description: 'Navbatdagi rejalashtirilgan xabarlar.',
            parameters: { type: 'object', properties: {} },
        },
        run: async (_a, ctx) => ({ summary: await pendingSummary(ctx.db, ctx.tenant) }),
    },

    // ===== YOZISH =====

    mute_reminders: {
        roles: ['super', 'coach'],
        decl: {
            name: 'mute_reminders',
            description:
                "A'zo uchun MA'LUM OVQAT bo'yicha eslatmani o'chiradi yoki qayta yoqadi. " +
                "Masalan odam nonushta qilmasa — faqat nonushta eslatmasi o'chiriladi, qolgani ishlayveradi.",
            parameters: {
                type: 'object',
                properties: {
                    member: S("A'zo ismi yoki id"),
                    meal_type: S("nonushta | tushlik | kechki | all (standart all)"),
                    muted: B("true — o'chirish, false — qayta yoqish"),
                },
                required: ['member', 'muted'],
            },
        },
        run: async (a, ctx) => {
            const { found, missing } = await resolveMembers(ctx.db, [String(a.member)]);
            if (!found.length) return { error: `A'zo topilmadi: ${missing.join(', ')}` };
            const member = found[0];

            const requested = normalizeMeal(a.meal_type);
            const meals: MealType[] =
                !a.meal_type || /^(all|hammasi|barchasi)$/i.test(String(a.meal_type)) || requested === 'any'
                    ? [...MEAL_TYPES]
                    : [requested];

            for (const meal of meals) {
                if (a.muted) {
                    await ctx.db.reminderOverride.upsert({
                        where: { memberId_mealType: { memberId: member.id, mealType: meal } },
                        create: { memberId: member.id, mealType: meal, muted: true },
                        update: { muted: true },
                    });
                } else {
                    await ctx.db.reminderOverride.deleteMany({ where: { memberId: member.id, mealType: meal } });
                }
            }

            await audit(ctx.tenant.id, ctx.actorTgId, 'ai.mute_reminders', `${member.name}: ${meals.join(',')} → ${a.muted ? 'off' : 'on'}`);
            return {
                member: member.name,
                meals: meals.map(m => MEAL_LABELS[m]),
                reminders: a.muted ? "o'chirildi" : 'yoqildi',
            };
        },
    },

    send_message_to_members: {
        roles: ['super', 'coach'],
        decl: {
            name: 'send_message_to_members',
            description:
                "A'zolarga shaxsiy xabar yuboradi — birinchi navbatda MURABBIYNING O'Z NOMIDAN " +
                '(Telegram Business orqali). Darhol yoki belgilangan vaqtda. Matnni murabbiy uslubida sen yozasan. ' +
                "MUHIM: natijada `sent` va `failed` bo'ladi — kimga YETIB BORGANINI aynan shundan olib ayt, " +
                "o'zingdan 'yuborildi' deb yozma.",
            parameters: {
                type: 'object',
                properties: {
                    text: S("Xabar matni. {name} — a'zo ismiga almashadi. Telegram HTML."),
                    member_ids: { type: 'array', items: { type: 'string' }, description: "A'zo id yoki ismlari" },
                    filter_inactive_days: N(
                        "Shu necha kun KETMA-KET yubormaganlarga. meal_type bilan birga ishlatilsa — " +
                            "aynan o'sha ovqatni shuncha kun ketma-ket yubormaganlar.",
                    ),
                    filter_missing_today: B('Bugun yubormaganlarga'),
                    filter_meal_type: S('nonushta | tushlik | kechki | any'),
                    group: S("Guruh yoki 'all'"),
                    send_at: S("'YYYY-MM-DD HH:mm' (bot vaqt mintaqasida). Bo'sh — darhol."),
                    delay_minutes: N('Necha daqiqadan keyin'),
                    channel: S('business (standart, murabbiy nomidan) | bot | group'),
                    fallback: B(
                        "Standart true. Murabbiy nomidan o'tmasa bot orqali, u ham o'tmasa guruhda teglab yuboradi. " +
                            'false — faqat tanlangan kanal.',
                    ),
                },
                required: ['text'],
            },
        },
        run: async (a, ctx) => {
            const text = String(a.text || '').trim();
            if (!text) return { error: "Xabar matni bo'sh" };

            const groupId = await resolveGroupId(ctx.db, a.group);
            let targets: any[] = [];

            if (Array.isArray(a.member_ids) && a.member_ids.length) {
                const { found, missing } = await resolveMembers(ctx.db, a.member_ids.map(String));
                targets = found;
                if (!found.length) return { error: `A'zolar topilmadi: ${missing.join('; ')}` };
            } else if (a.filter_inactive_days) {
                const rows = await findInactive(ctx.db, ctx.tenant, {
                    days: Number(a.filter_inactive_days),
                    mealType: normalizeMeal(a.filter_meal_type),
                    groupId,
                });
                targets = await ctx.db.member.findMany({ where: { id: { in: rows.map(r => r.id) } } });
            } else if (a.filter_missing_today) {
                const rows = await findMissingToday(ctx.db, { mealType: normalizeMeal(a.filter_meal_type), groupId });
                targets = await ctx.db.member.findMany({ where: { id: { in: rows.map(r => r.id) } } });
            } else {
                return { error: "Kimga yuborish ko'rsatilmagan: member_ids yoki filter kerak." };
            }

            if (targets.length === 0) return { sent: 0, message: "Bu shartga mos a'zo topilmadi." };

            const tz = safeTz(ctx.tenant.timezone);
            let when = new Date();
            if (a.send_at) {
                const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})$/.exec(String(a.send_at).trim());
                if (!m) return { error: "send_at formati noto'g'ri. Namuna: 2026-08-20 09:00" };
                when = localDateTimeToUtc(m[1], m[2], tz);
            } else if (a.delay_minutes) {
                when = new Date(Date.now() + Number(a.delay_minutes) * 60_000);
            }

            const channel: Channel =
                a.channel === 'bot' ? 'bot' : a.channel === 'group' ? 'group' : 'business';
            const fallback = a.fallback !== false;
            const businessReady = channel !== 'business' || !!(await activeConnection(ctx.db, ctx.actorTgId));

            if (channel === 'business' && !businessReady && !fallback) {
                return {
                    error:
                        "Telegram Business ulanishi yo'q — murabbiy nomidan yuborib bo'lmaydi. " +
                        'Telegram → Sozlamalar → Business → Chatbots orqali botni ulang va "Reply to messages" ni yoqing.',
                };
            }

            const body = (m: any) => text.replace(/\{name\}/g, esc(m.name));
            const immediate = when.getTime() <= Date.now() + 30_000;

            // ---- Kelajakka rejalashtirilgan: faqat navbatga qo'yiladi ----
            if (!immediate) {
                for (const m of targets) {
                    await enqueue(ctx.db, {
                        memberId: m.id,
                        chatId: m.telegramId,
                        text: body(m),
                        channel,
                        scheduledFor: when,
                        createdByTgId: ctx.actorTgId,
                        batchId: ctx.batchId,
                    });
                }
                await audit(ctx.tenant.id, ctx.actorTgId, 'ai.schedule_messages', `${targets.length} ta, ${channel}`);
                return {
                    sent: 0,
                    scheduled: targets.length,
                    recipients: targets.map(t => t.name),
                    when: formatIn(when, tz, 'dd.MM.yyyy HH:mm'),
                    note:
                        "HALI YUBORILMADI. Foydalanuvchiga 'yuborildi' DEMA — " +
                        "belgilangan vaqtda yuborilishi rejalashtirilganini ayt.",
                };
            }

            // ---- Darhol: haqiqatan yuboramiz va HAQIQIY natijani qaytaramiz ----
            const first = targets.slice(0, IMMEDIATE_LIMIT);
            const rest = targets.slice(IMMEDIATE_LIMIT);
            const delivered: string[] = [];
            const failed: Array<{ name: string; reason: string }> = [];

            for (const m of first) {
                const res = await deliverToMember(
                    ctx.db,
                    ctx.tenant,
                    { id: m.id, telegramId: m.telegramId, name: m.name },
                    body(m),
                    { preferred: channel, fallback, coachTgId: ctx.actorTgId },
                );
                await recordSend(ctx.db, {
                    memberId: m.id,
                    chatId: m.telegramId,
                    text: body(m),
                    channel,
                    createdByTgId: ctx.actorTgId,
                    batchId: ctx.batchId,
                    ok: res.ok,
                    via: res.via,
                    error: res.error ?? describeAttempts(res.attempts),
                });
                if (res.ok) delivered.push(`${m.name} — ${CHANNEL_LABEL[res.via!]}`);
                else failed.push({ name: m.name, reason: res.error ?? 'Yetib bormadi' });
            }

            // Juda ko'p bo'lsa qolganini navbatga qo'yamiz — AI javobi kutib qolmasin
            for (const m of rest) {
                await enqueue(ctx.db, {
                    memberId: m.id,
                    chatId: m.telegramId,
                    text: body(m),
                    channel,
                    createdByTgId: ctx.actorTgId,
                    batchId: ctx.batchId,
                });
            }

            await audit(
                ctx.tenant.id,
                ctx.actorTgId,
                'ai.send_messages',
                `${delivered.length} yetdi, ${failed.length} xato, ${rest.length} navbatda`,
            );

            return {
                sent: delivered.length,
                delivered,
                failed,
                queued: rest.length,
                note: failed.length
                    ? "Ba'zilariga YETIB BORMADI. Har birining sababini foydalanuvchiga aynan ayt."
                    : undefined,
            };
        },
    },

    list_failed_messages: {
        roles: ['super', 'coach'],
        decl: {
            name: 'list_failed_messages',
            description:
                "Yetib bormagan xabarlar ro'yxati va SABABI. Murabbiy 'nega yetib bormadi' deb so'rasa shuni chaqir.",
            parameters: { type: 'object', properties: { limit: N('Nechta (standart 20)') } },
        },
        run: async (a, ctx) => {
            const rows = await listFailed(ctx.db, Math.min(50, Number(a.limit) || 20));
            return { count: rows.length, messages: rows };
        },
    },

    cancel_scheduled_messages: {
        roles: ['super', 'coach'],
        decl: {
            name: 'cancel_scheduled_messages',
            description: 'Hali yuborilmagan rejalashtirilgan xabarlarni bekor qiladi.',
            parameters: { type: 'object', properties: { confirm: B('Tasdiqlash') }, required: ['confirm'] },
        },
        run: async (a, ctx) => (a.confirm ? { cancelled: await cancelPending(ctx.db) } : { error: 'Tasdiqlanmadi' }),
    },

    post_to_group: {
        roles: ['super', 'coach'],
        decl: {
            name: 'post_to_group',
            description: "Guruhga bot nomidan xabar yuborish (e'lon, motivatsiya).",
            parameters: {
                type: 'object',
                properties: { text: S('Matn (Telegram HTML)'), group: S("Guruh yoki 'all'") },
                required: ['text'],
            },
        },
        run: async (a, ctx) => {
            const bot = getBotByTenant(ctx.tenant.id);
            if (!bot) return { error: 'Bot faol emas' };
            const groupId = await resolveGroupId(ctx.db, a.group);
            const groups = await ctx.db.group.findMany({
                where: { ...LIVE_GROUP, ...(groupId ? { id: groupId } : {}) },
            });
            const results: string[] = [];
            for (const g of groups) {
                try {
                    await bot.telegram.sendMessage(g.chatId, String(a.text), { parse_mode: 'HTML' });
                    results.push(`${g.title || g.chatId}: ✅`);
                } catch (e) {
                    results.push(`${g.title || g.chatId}: ❌ ${tgError(e)}`);
                }
            }
            return { groups: results.length, results };
        },
    },

    update_settings: {
        roles: ['super', 'coach'],
        decl: {
            name: 'update_settings',
            description: "Bot sozlamalarini o'zgartiradi. Faqat kerakli maydonlarni ber.",
            parameters: {
                type: 'object',
                properties: {
                    breakfast_time: S("'HH:mm'"),
                    lunch_time: S("'HH:mm'"),
                    dinner_time: S("'HH:mm'"),
                    grace_minutes: N("Necha daqiqadan keyin 'kech'"),
                    reminder_interval: N('Eslatmalar orasidagi daqiqa'),
                    max_reminders: N('Maksimal eslatma soni'),
                    daily_table_hour: N('Kunlik jadval soati (0-23)'),
                    require_photo: B('Rasm majburiymi'),
                    auto_delete_reminders: B("Ovqat kelganda eslatma o'chirilsinmi"),
                    timezone: S("Masalan 'Asia/Tashkent'"),
                    agent_name: S('AI yordamchining ismi'),
                    coach_style: S('Murabbiyning yozish uslubi'),
                    breakfast_words: S("Kalit so'zlar, vergul bilan"),
                    lunch_words: S("Kalit so'zlar, vergul bilan"),
                    dinner_words: S("Kalit so'zlar, vergul bilan"),
                },
            },
        },
        run: async (a, ctx) => {
            const data: Record<string, unknown> = {};
            const timeRe = /^([01]\d|2[0-3]):[0-5]\d$/;

            for (const [key, field] of [
                ['breakfast_time', 'breakfastTime'],
                ['lunch_time', 'lunchTime'],
                ['dinner_time', 'dinnerTime'],
            ] as const) {
                if (a[key] === undefined) continue;
                if (!timeRe.test(String(a[key]))) throw new Error(`${key} noto'g'ri: 'HH:mm' bo'lishi kerak`);
                data[field] = String(a[key]);
            }

            const nums: Array<[string, string, number, number]> = [
                ['grace_minutes', 'graceMinutes', 0, 720],
                ['reminder_interval', 'reminderInterval', 5, 1440],
                ['max_reminders', 'maxReminders', 0, 20],
                ['daily_table_hour', 'dailyTableHour', 0, 23],
            ];
            for (const [key, field, min, max] of nums) {
                if (a[key] === undefined) continue;
                const v = Math.round(Number(a[key]));
                if (!Number.isFinite(v) || v < min || v > max) throw new Error(`${key} ${min}..${max} oralig'ida bo'lsin`);
                data[field] = v;
            }

            if (a.require_photo !== undefined) data.requirePhoto = !!a.require_photo;
            if (a.auto_delete_reminders !== undefined) data.autoDeleteReminders = !!a.auto_delete_reminders;
            if (a.timezone) data.timezone = safeTz(String(a.timezone));
            if (a.agent_name) data.agentName = String(a.agent_name).slice(0, 40);
            if (a.coach_style !== undefined) data.coachStyle = String(a.coach_style).slice(0, 2000);
            if (a.breakfast_words) data.breakfastWords = String(a.breakfast_words);
            if (a.lunch_words) data.lunchWords = String(a.lunch_words);
            if (a.dinner_words) data.dinnerWords = String(a.dinner_words);

            if (Object.keys(data).length === 0) return { error: "Hech qanday sozlama ko'rsatilmadi" };

            ctx.tenant = await prisma.tenant.update({ where: { id: ctx.tenant.id }, data });
            await audit(ctx.tenant.id, ctx.actorTgId, 'ai.update_settings', Object.keys(data).join(', '));
            return { updated: Object.keys(data), settings_now: data };
        },
    },

    set_member_role: {
        roles: ['super', 'coach'],
        decl: {
            name: 'set_member_role',
            description: "A'zoning rolini o'zgartirish. coach — bot boshqaruviga ruxsat.",
            parameters: {
                type: 'object',
                properties: { member: S("A'zo ismi yoki id"), role: S('member | coach') },
                required: ['member', 'role'],
            },
        },
        run: async (a, ctx) => {
            const role = String(a.role).toLowerCase();
            if (!['member', 'coach'].includes(role)) return { error: 'Rol: member yoki coach' };
            const { found, missing } = await resolveMembers(ctx.db, [String(a.member)]);
            if (!found.length) return { error: `A'zo topilmadi: ${missing.join(', ')}` };
            const m = await ctx.db.member.update({ where: { id: found[0].id }, data: { role } });
            await audit(ctx.tenant.id, ctx.actorTgId, 'ai.set_role', `${m.name} → ${role}`);
            return { member: m.name, role };
        },
    },

    refresh_tables: {
        roles: ['super', 'coach'],
        decl: {
            name: 'refresh_tables',
            description: 'Barcha guruhlardagi pinlangan jadvalni darhol yangilash.',
            parameters: { type: 'object', properties: {} },
        },
        run: async (_a, ctx) => {
            const groups = await ctx.db.group.findMany({ where: LIVE_GROUP });
            for (const g of groups) await updateGroupTable(ctx.db, ctx.tenant, g).catch(() => undefined);
            return { refreshed: groups.length };
        },
    },

    // ===== SUPER ADMIN =====

    list_bots: {
        roles: ['super'],
        decl: {
            name: 'list_bots',
            description: 'Platformadagi barcha botlar va holati. Faqat super admin.',
            parameters: { type: 'object', properties: {} },
        },
        run: async () => {
            const tenants = await prisma.tenant.findMany({ orderBy: { createdAt: 'asc' } });
            return Promise.all(
                tenants.map(async t => {
                    const db = await tenantDb(t.botId);
                    return {
                        id: t.id,
                        username: `@${t.botUsername}`,
                        status: t.status,
                        groups: await db.group.count({ where: LIVE_GROUP }),
                        members: await db.member.count({ where: { status: 'active' } }),
                        meals_total: await db.mealRecord.count(),
                    };
                }),
            );
        },
    },

    list_pending_groups: {
        roles: ['super'],
        decl: {
            name: 'list_pending_groups',
            description: 'Tasdiq kutayotgan guruhlar (barcha botlar bo\'ylab). Faqat super admin.',
            parameters: { type: 'object', properties: {} },
        },
        run: async () => {
            const rows = await pendingGroups();
            return {
                count: rows.length,
                groups: rows.map(r => ({
                    bot: `@${r.tenant.botUsername}`,
                    tenant_id: r.tenant.id,
                    group_id: r.group.id,
                    title: r.group.title || '(nomsiz)',
                    chat_id: r.group.chatId,
                })),
            };
        },
    },

    decide_group: {
        roles: ['super'],
        decl: {
            name: 'decide_group',
            description: 'Kutayotgan guruhni tasdiqlash yoki rad etish. Faqat super admin.',
            parameters: {
                type: 'object',
                properties: {
                    group_id: S('list_pending_groups bergan group_id'),
                    tenant_id: S('Qaysi botga tegishli'),
                    approve: B('true — tasdiqlash, false — rad etish'),
                },
                required: ['group_id', 'tenant_id', 'approve'],
            },
        },
        run: async (a, ctx) => {
            const t = await prisma.tenant.findUnique({ where: { id: String(a.tenant_id) } });
            if (!t) return { error: 'Bot topilmadi' };
            const g = a.approve
                ? await approveGroup(t, String(a.group_id), ctx.actorTgId)
                : await rejectGroup(t, String(a.group_id), ctx.actorTgId);
            return { group: g.title || g.chatId, status: g.status };
        },
    },

    add_group_to_bot: {
        roles: ['super'],
        decl: {
            name: 'add_group_to_bot',
            description: 'Guruhni chat id orqali qo\'shish (darrov tasdiqlangan). Faqat super admin.',
            parameters: {
                type: 'object',
                properties: { chat_id: S('Masalan -1001234567890'), title: S('Guruh nomi') },
                required: ['chat_id'],
            },
        },
        run: async (a, ctx) => {
            const res = await addGroup(ctx.tenant, String(a.chat_id), String(a.title || ''), ctx.actorTgId);
            return { added: res.created, group_id: res.id };
        },
    },

    set_bot_status: {
        roles: ['super'],
        decl: {
            name: 'set_bot_status',
            description: "Botni to'xtatish yoki ishga tushirish. Faqat super admin.",
            parameters: {
                type: 'object',
                properties: { bot: S('Bot username yoki id'), status: S('active | paused') },
                required: ['bot', 'status'],
            },
        },
        run: async (a, ctx) => {
            const target = await findTenantByHint(String(a.bot));
            if (!target) return { error: 'Bot topilmadi' };
            const t =
                a.status === 'paused'
                    ? await pauseTenant(target.id, ctx.actorTgId)
                    : await resumeTenant(target.id, ctx.actorTgId);
            return { bot: `@${t.botUsername}`, status: t.status };
        },
    },

    purge_bot_data: {
        roles: ['super'],
        decl: {
            name: 'purge_bot_data',
            description:
                "Bot ma'lumotlarini o'chirish. scope: meals | members | mentions | ai | outbox | all. " +
                "Qaytarib bo'lmaydi! Faqat super admin.",
            parameters: {
                type: 'object',
                properties: {
                    bot: S("Bot username. Bo'sh — joriy bot."),
                    scope: S('meals | members | mentions | ai | outbox | all'),
                    confirm: B('Majburiy true'),
                },
                required: ['scope', 'confirm'],
            },
        },
        run: async (a, ctx) => {
            if (!a.confirm) return { error: "Tasdiqlanmadi — o'chirish bekor qilindi" };
            const scopes: PurgeScope[] = ['meals', 'members', 'mentions', 'ai', 'outbox', 'all'];
            if (!scopes.includes(a.scope)) return { error: `scope noto'g'ri. Ruxsat: ${scopes.join(', ')}` };
            const target = a.bot ? await findTenantByHint(String(a.bot)) : ctx.tenant;
            if (!target) return { error: 'Bot topilmadi' };
            return { bot: `@${target.botUsername}`, purged: await purgeTenantData(target, a.scope as PurgeScope, ctx.actorTgId) };
        },
    },
};

export function declarationsFor(role: Role): FunctionDeclaration[] {
    return Object.values(TOOLS)
        .filter(t => t.roles.includes(role))
        .map(t => t.decl);
}

export async function runTool(name: string, args: any, ctx: ToolContext): Promise<unknown> {
    const tool = TOOLS[name];
    if (!tool) return { error: `Noma'lum funksiya: ${name}` };
    if (!tool.roles.includes(ctx.role)) return { error: `Sizda "${name}" uchun ruxsat yo'q (rol: ${ctx.role})` };
    try {
        return await tool.run(args ?? {}, ctx);
    } catch (e: any) {
        log.error('ai-tool', `${name} xatosi`, e);
        return { error: e?.message ? String(e.message) : 'Ichki xato' };
    }
}
