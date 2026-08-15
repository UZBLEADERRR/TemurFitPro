import type { Tenant } from '@prisma/client';
import { prisma } from '../core/db';
import type { FunctionDeclaration } from './gemini';
import {
    listGroups, listMembers, findInactive, findMissingToday, getStats,
    memberReport, searchMembers,
} from '../features/filters';
import { enqueue, pendingSummary, cancelPending } from '../features/outbox';
import { connectionSummary, activeConnection } from '../features/business';
import { addGroup, purgeTenantData, pauseTenant, resumeTenant, audit, PurgeScope } from '../core/tenants';
import { getBotByTenant } from '../core/registry';
import { updateGroupTable } from '../features/table';
import { MEAL_TYPES, MEAL_LABELS, isMealType, MealType } from '../core/meals';
import { todayIn, safeTz, localDateTimeToUtc, formatIn } from '../core/time';
import { esc, tgError } from '../core/telegram';
import { log } from '../core/logger';

export type Role = 'super' | 'coach' | 'member';

export interface ToolContext {
    tenant: Tenant;
    actorTgId: string;
    role: Role;
    /// Faqat shu partiyaga tegishli xabarlarni kuzatish uchun
    batchId: string;
}

interface ToolDef {
    decl: FunctionDeclaration;
    /// Qaysi rollarga ruxsat
    roles: Role[];
    run: (args: any, ctx: ToolContext) => Promise<unknown>;
}

const S = (desc: string) => ({ type: 'string', description: desc });
const N = (desc: string) => ({ type: 'number', description: desc });
const B = (desc: string) => ({ type: 'boolean', description: desc });

// ---------- yordamchilar ----------

async function resolveGroupId(tenantId: string, hint?: string): Promise<string | null> {
    if (!hint || hint === 'all' || hint === 'hammasi') return null;
    const groups = await prisma.group.findMany({ where: { tenantId, isActive: true } });
    const lower = hint.toLowerCase();
    const found =
        groups.find(g => g.id === hint) ||
        groups.find(g => g.chatId === hint) ||
        groups.find(g => (g.title || '').toLowerCase().includes(lower));
    return found?.id ?? null;
}

async function resolveMembers(tenantId: string, queries: string[]): Promise<{ found: any[]; missing: string[] }> {
    const found: any[] = [];
    const missing: string[] = [];
    for (const q of queries) {
        const direct = await prisma.member.findFirst({
            where: { tenantId, OR: [{ id: q }, { telegramId: q }] },
        });
        if (direct) {
            found.push(direct);
            continue;
        }
        const hits = await searchMembers(tenantId, q);
        if (hits.length === 1) {
            const m = await prisma.member.findUnique({ where: { id: hits[0].id } });
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
    // ===== O'QISH =====
    list_groups: {
        roles: ['super', 'coach'],
        decl: {
            name: 'list_groups',
            description: "Shu botga ulangan barcha guruhlar ro'yxati (nomi, chat id, a'zolar soni).",
            parameters: { type: 'object', properties: {} },
        },
        run: async (_a, ctx) => {
            const groups = await listGroups(ctx.tenant.id);
            return Promise.all(
                groups.map(async g => ({
                    id: g.id,
                    title: g.title || '(nomsiz)',
                    chat_id: g.chatId,
                    members: await prisma.groupMember.count({ where: { groupId: g.id } }),
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
                    group: S("Guruh nomi/id. Bo'sh yoki 'all' — barcha guruhlar."),
                    role: S("member | coach | owner. Bo'sh — hammasi."),
                },
            },
        },
        run: async (a, ctx) => {
            const groupId = await resolveGroupId(ctx.tenant.id, a.group);
            const rows = await listMembers(ctx.tenant.id, { groupId, role: a.role });
            return { count: rows.length, members: rows.map(r => ({ id: r.id, name: r.name, role: r.role, groups: r.groups, timezone: r.timezone })) };
        },
    },

    find_inactive: {
        roles: ['super', 'coach'],
        decl: {
            name: 'find_inactive',
            description:
                "Oxirgi N kun ichida ovqat rasmini yubormagan a'zolarni topadi. " +
                "Murabbiyning eng ko'p ishlatadigan so'rovi: \"oxirgi 2 kunda jo'natmaganlar\".",
            parameters: {
                type: 'object',
                properties: {
                    days: N("Necha kun tekshirilsin (standart 2). Bugungi tugallanmagan kun hisobga olinmaydi."),
                    meal_type: S('nonushta | tushlik | kechki | any (standart any)'),
                    group: S("Guruh nomi/id yoki 'all'"),
                },
                required: ['days'],
            },
        },
        run: async (a, ctx) => {
            const groupId = await resolveGroupId(ctx.tenant.id, a.group);
            const rows = await findInactive(ctx.tenant, {
                days: Number(a.days) || 2,
                mealType: normalizeMeal(a.meal_type),
                groupId,
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
                properties: {
                    meal_type: S('nonushta | tushlik | kechki | any'),
                    group: S("Guruh nomi/id yoki 'all'"),
                },
            },
        },
        run: async (a, ctx) => {
            const groupId = await resolveGroupId(ctx.tenant.id, a.group);
            const rows = await findMissingToday(ctx.tenant, { mealType: normalizeMeal(a.meal_type), groupId });
            return { count: rows.length, members: rows.map(r => ({ id: r.id, name: r.name, groups: r.groups })) };
        },
    },

    get_stats: {
        roles: ['super', 'coach'],
        decl: {
            name: 'get_stats',
            description: "Intizom statistikasi: har bir a'zoning bajarilish foizi, kechikishlari.",
            parameters: {
                type: 'object',
                properties: {
                    days: N('Necha kunlik davr (standart 7)'),
                    group: S("Guruh nomi/id yoki 'all'"),
                },
            },
        },
        run: async (a, ctx) => {
            const groupId = await resolveGroupId(ctx.tenant.id, a.group);
            const res = await getStats(ctx.tenant, { days: Number(a.days) || 7, groupId });
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
            description: "Bitta a'zoning kunma-kun batafsil hisoboti.",
            parameters: {
                type: 'object',
                properties: {
                    member: S("A'zo ismi, username yoki id"),
                    days: N('Necha kunlik (standart 7)'),
                },
                required: ['member'],
            },
        },
        run: async (a, ctx) => {
            const { found, missing } = await resolveMembers(ctx.tenant.id, [String(a.member)]);
            if (!found.length) return { error: `A'zo topilmadi: ${missing.join(', ')}` };
            const rep = await memberReport(ctx.tenant, found[0].id, Number(a.days) || 7);
            if (!rep) return { error: "Hisobot tuzilmadi" };
            return {
                name: rep.member.name,
                timezone: rep.member.timezone,
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
            description: "A'zolarni ism/username bo'yicha izlash. Xabar yuborishdan oldin id topish uchun.",
            parameters: { type: 'object', properties: { query: S('Qidiruv matni') }, required: ['query'] },
        },
        run: async (a, ctx) => {
            const rows = await searchMembers(ctx.tenant.id, String(a.query));
            return { count: rows.length, members: rows.map(r => ({ id: r.id, name: r.name, username: r.username, role: r.role })) };
        },
    },

    get_settings: {
        roles: ['super', 'coach'],
        decl: {
            name: 'get_settings',
            description: 'Botning joriy sozlamalari (ovqat vaqtlari, eslatma oralig\'i, kalit so\'zlar, AI nomi).',
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
                auto_delete_reminders: t.autoDeleteReminders,
                breakfast_words: t.breakfastWords,
                lunch_words: t.lunchWords,
                dinner_words: t.dinnerWords,
            };
        },
    },

    business_status: {
        roles: ['super', 'coach'],
        decl: {
            name: 'business_status',
            description: 'Telegram Business ulanishi holati — murabbiy nomidan xabar yuborish mumkinmi.',
            parameters: { type: 'object', properties: {} },
        },
        run: async (_a, ctx) => {
            const conn = await activeConnection(ctx.tenant.id, ctx.actorTgId);
            return {
                ready: !!conn,
                connection: conn ? { user: conn.userName, can_reply: conn.canReply, enabled: conn.isEnabled } : null,
                hint: conn ? null : 'Telegram → Sozlamalar → Telegram Business → Chatbots orqali botni ulash kerak.',
            };
        },
    },

    list_scheduled_messages: {
        roles: ['super', 'coach'],
        decl: {
            name: 'list_scheduled_messages',
            description: 'Navbatdagi (hali yuborilmagan) rejalashtirilgan xabarlar.',
            parameters: { type: 'object', properties: {} },
        },
        run: async (_a, ctx) => ({ summary: await pendingSummary(ctx.tenant) }),
    },

    // ===== YOZISH =====
    send_message_to_members: {
        roles: ['super', 'coach'],
        decl: {
            name: 'send_message_to_members',
            description:
                "A'zolarga shaxsiy xabar yuboradi — MURABBIYNING O'Z NOMIDAN (Telegram Business orqali). " +
                "Darhol yoki belgilangan vaqtda yuborish mumkin. Matnni murabbiyning uslubida sen yozasan. " +
                "Kimga yuborishni ikki usulda ko'rsatish mumkin: aniq member_ids ro'yxati, yoki filter (masalan 2 kun yubormaganlar).",
            parameters: {
                type: 'object',
                properties: {
                    text: S("Xabar matni. {name} yozsang — har bir a'zoning ismiga almashadi. Telegram HTML: <b>, <i> ishlaydi."),
                    member_ids: {
                        type: 'array',
                        items: { type: 'string' },
                        description: "A'zo id yoki ismlari ro'yxati. filter berilsa shart emas.",
                    },
                    filter_inactive_days: N("Shu kun soni davomida yubormaganlarga yuborish (masalan 2). member_ids berilsa shart emas."),
                    filter_missing_today: B('Bugun yubormaganlarga yuborish'),
                    filter_meal_type: S('nonushta | tushlik | kechki | any — filter bilan birga'),
                    group: S("Guruh nomi/id yoki 'all' — filterni cheklash uchun"),
                    send_at: S("Yuborish vaqti 'YYYY-MM-DD HH:mm' (bot vaqt mintaqasida). Bo'sh — darhol."),
                    delay_minutes: N('Necha daqiqadan keyin yuborilsin. send_at bilan birga ishlatilmaydi.'),
                    channel: S("business (murabbiy nomidan, standart) yoki bot (bot nomidan)"),
                },
                required: ['text'],
            },
        },
        run: async (a, ctx) => {
            const text = String(a.text || '').trim();
            if (!text) return { error: "Xabar matni bo'sh" };

            // 1) Kimga?
            let targets: any[] = [];
            const groupId = await resolveGroupId(ctx.tenant.id, a.group);

            if (Array.isArray(a.member_ids) && a.member_ids.length) {
                const { found, missing } = await resolveMembers(ctx.tenant.id, a.member_ids.map(String));
                targets = found;
                if (missing.length && !found.length) return { error: `A'zolar topilmadi: ${missing.join('; ')}` };
            } else if (a.filter_inactive_days) {
                const rows = await findInactive(ctx.tenant, {
                    days: Number(a.filter_inactive_days),
                    mealType: normalizeMeal(a.filter_meal_type),
                    groupId,
                });
                targets = await prisma.member.findMany({ where: { id: { in: rows.map(r => r.id) } } });
            } else if (a.filter_missing_today) {
                const rows = await findMissingToday(ctx.tenant, { mealType: normalizeMeal(a.filter_meal_type), groupId });
                targets = await prisma.member.findMany({ where: { id: { in: rows.map(r => r.id) } } });
            } else {
                return { error: "Kimga yuborish ko'rsatilmagan: member_ids yoki filter kerak." };
            }

            if (targets.length === 0) return { sent: 0, message: "Bu shartga mos a'zo topilmadi — hech kimga yuborilmadi." };

            // 2) Qachon?
            const tz = safeTz(ctx.tenant.timezone);
            let when = new Date();
            if (a.send_at) {
                const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})$/.exec(String(a.send_at).trim());
                if (!m) return { error: "send_at formati noto'g'ri. Namuna: 2026-08-16 09:00" };
                when = localDateTimeToUtc(m[1], m[2], tz);
            } else if (a.delay_minutes) {
                when = new Date(Date.now() + Number(a.delay_minutes) * 60_000);
            }

            // 3) Kanal
            const channel = a.channel === 'bot' ? 'bot' : 'business';
            if (channel === 'business') {
                const conn = await activeConnection(ctx.tenant.id, ctx.actorTgId);
                if (!conn) {
                    return {
                        error:
                            "Telegram Business ulanishi yo'q — murabbiy nomidan yuborib bo'lmaydi. " +
                            'Telegram → Sozlamalar → Telegram Business → Chatbots orqali botni ulang va "Reply to messages" ni yoqing.',
                    };
                }
            }

            // 4) Navbatga qo'yish
            for (const m of targets) {
                await enqueue({
                    tenantId: ctx.tenant.id,
                    memberId: m.id,
                    chatId: m.telegramId,
                    text: text.replace(/\{name\}/g, esc(m.name)),
                    channel,
                    scheduledFor: when,
                    createdByTgId: ctx.actorTgId,
                    batchId: ctx.batchId,
                });
            }

            await audit(ctx.tenant.id, ctx.actorTgId, 'ai.send_messages', `${targets.length} ta, ${channel}`);

            const immediate = when.getTime() <= Date.now() + 30_000;
            return {
                queued: targets.length,
                recipients: targets.map(t => t.name),
                channel,
                when: immediate ? 'darhol' : formatIn(when, tz, 'dd.MM.yyyy HH:mm'),
                note: immediate
                    ? 'Xabarlar bir daqiqa ichida yuboriladi.'
                    : `Belgilangan vaqtda avtomatik yuboriladi (${tz}).`,
            };
        },
    },

    cancel_scheduled_messages: {
        roles: ['super', 'coach'],
        decl: {
            name: 'cancel_scheduled_messages',
            description: 'Hali yuborilmagan barcha rejalashtirilgan xabarlarni bekor qiladi.',
            parameters: { type: 'object', properties: { confirm: B('Tasdiqlash uchun true') }, required: ['confirm'] },
        },
        run: async (a, ctx) => {
            if (!a.confirm) return { error: 'Tasdiqlanmadi' };
            const count = await cancelPending(ctx.tenant.id);
            return { cancelled: count };
        },
    },

    post_to_group: {
        roles: ['super', 'coach'],
        decl: {
            name: 'post_to_group',
            description: 'Guruhga bot nomidan xabar yuborish (e\'lon, motivatsiya, ogohlantirish).',
            parameters: {
                type: 'object',
                properties: {
                    text: S('Xabar matni (Telegram HTML)'),
                    group: S("Guruh nomi/id. 'all' — barcha guruhlarga."),
                },
                required: ['text'],
            },
        },
        run: async (a, ctx) => {
            const bot = getBotByTenant(ctx.tenant.id);
            if (!bot) return { error: 'Bot faol emas' };
            const groupId = await resolveGroupId(ctx.tenant.id, a.group);
            const groups = await prisma.group.findMany({
                where: { tenantId: ctx.tenant.id, isActive: true, ...(groupId ? { id: groupId } : {}) },
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
            description:
                "Bot sozlamalarini o'zgartiradi. Faqat o'zgartirilishi kerak bo'lgan maydonlarni ber. " +
                "Masalan: \"nonushtani 7:30 ga o'zgartir\" → breakfast_time: '07:30'.",
            parameters: {
                type: 'object',
                properties: {
                    breakfast_time: S("Nonushta vaqti 'HH:mm'"),
                    lunch_time: S("Tushlik vaqti 'HH:mm'"),
                    dinner_time: S("Kechki ovqat vaqti 'HH:mm'"),
                    grace_minutes: N("Necha daqiqadan keyin 'kech' hisoblansin"),
                    reminder_interval: N('Eslatmalar orasidagi daqiqa'),
                    max_reminders: N('Bir ovqat uchun maksimal eslatma soni'),
                    daily_table_hour: N('Kunlik jadval yuboriladigan soat (0-23)'),
                    require_photo: B("Rasm majburiymi (false bo'lsa faqat hashtag ham yetadi)"),
                    auto_delete_reminders: B("Ovqat kelganda eslatma xabari o'chirilsinmi"),
                    timezone: S("Bot vaqt mintaqasi, masalan 'Asia/Tashkent'"),
                    agent_name: S('AI yordamchining ismi'),
                    coach_style: S("Murabbiyning yozish uslubi — AI xabarlarni shu uslubda yozadi"),
                    breakfast_words: S("Nonushta kalit so'zlari, vergul bilan"),
                    lunch_words: S("Tushlik kalit so'zlari, vergul bilan"),
                    dinner_words: S("Kechki ovqat kalit so'zlari, vergul bilan"),
                },
            },
        },
        run: async (a, ctx) => {
            const data: Record<string, unknown> = {};
            const timeRe = /^([01]\d|2[0-3]):[0-5]\d$/;
            const setTime = (key: string, field: string) => {
                if (a[key] === undefined) return;
                if (!timeRe.test(String(a[key]))) throw new Error(`${key} noto'g'ri: 'HH:mm' formatida bo'lishi kerak`);
                data[field] = String(a[key]);
            };
            setTime('breakfast_time', 'breakfastTime');
            setTime('lunch_time', 'lunchTime');
            setTime('dinner_time', 'dinnerTime');

            const setNum = (key: string, field: string, min: number, max: number) => {
                if (a[key] === undefined) return;
                const v = Math.round(Number(a[key]));
                if (Number.isNaN(v) || v < min || v > max) throw new Error(`${key} ${min}..${max} oralig'ida bo'lishi kerak`);
                data[field] = v;
            };
            setNum('grace_minutes', 'graceMinutes', 0, 720);
            setNum('reminder_interval', 'reminderInterval', 5, 1440);
            setNum('max_reminders', 'maxReminders', 0, 20);
            setNum('daily_table_hour', 'dailyTableHour', 0, 23);

            if (a.require_photo !== undefined) data.requirePhoto = !!a.require_photo;
            if (a.auto_delete_reminders !== undefined) data.autoDeleteReminders = !!a.auto_delete_reminders;
            if (a.timezone) data.timezone = safeTz(String(a.timezone));
            if (a.agent_name) data.agentName = String(a.agent_name).slice(0, 40);
            if (a.coach_style !== undefined) data.coachStyle = String(a.coach_style).slice(0, 2000);
            if (a.breakfast_words) data.breakfastWords = String(a.breakfast_words);
            if (a.lunch_words) data.lunchWords = String(a.lunch_words);
            if (a.dinner_words) data.dinnerWords = String(a.dinner_words);

            if (Object.keys(data).length === 0) return { error: "Hech qanday sozlama ko'rsatilmadi" };

            const updated = await prisma.tenant.update({ where: { id: ctx.tenant.id }, data });
            ctx.tenant = updated; // keyingi tool chaqiruvlari yangi qiymatni ko'rsin
            await audit(ctx.tenant.id, ctx.actorTgId, 'ai.update_settings', Object.keys(data).join(', '));
            return { updated: Object.keys(data), settings_now: data };
        },
    },

    mute_reminders: {
        roles: ['super', 'coach'],
        decl: {
            name: 'mute_reminders',
            description: "A'zo uchun eslatmalarni o'chirish yoki qayta yoqish (masalan kasal yoki safarda).",
            parameters: {
                type: 'object',
                properties: {
                    member: S("A'zo ismi yoki id"),
                    meal_type: S('nonushta | tushlik | kechki | all'),
                    muted: B("true — o'chirish, false — yoqish"),
                },
                required: ['member', 'muted'],
            },
        },
        run: async (a, ctx) => {
            const { found, missing } = await resolveMembers(ctx.tenant.id, [String(a.member)]);
            if (!found.length) return { error: `A'zo topilmadi: ${missing.join(', ')}` };
            const member = found[0];
            const meals = a.meal_type && a.meal_type !== 'all' ? [normalizeMeal(a.meal_type)] : [...MEAL_TYPES];
            for (const meal of meals) {
                if (meal === 'any') continue;
                if (a.muted) {
                    await prisma.reminderOverride.upsert({
                        where: { memberId_mealType: { memberId: member.id, mealType: meal } },
                        create: { tenantId: ctx.tenant.id, memberId: member.id, mealType: meal, muted: true },
                        update: { muted: true },
                    });
                } else {
                    await prisma.reminderOverride.deleteMany({ where: { memberId: member.id, mealType: meal } });
                }
            }
            return { member: member.name, muted: !!a.muted, meals };
        },
    },

    set_member_role: {
        roles: ['super', 'coach'],
        decl: {
            name: 'set_member_role',
            description: "A'zoning rolini o'zgartirish. coach — bot boshqaruviga ruxsat beradi.",
            parameters: {
                type: 'object',
                properties: { member: S("A'zo ismi yoki id"), role: S('member | coach') },
                required: ['member', 'role'],
            },
        },
        run: async (a, ctx) => {
            const role = String(a.role).toLowerCase();
            if (!['member', 'coach'].includes(role)) return { error: 'Rol faqat member yoki coach bo\'lishi mumkin' };
            const { found, missing } = await resolveMembers(ctx.tenant.id, [String(a.member)]);
            if (!found.length) return { error: `A'zo topilmadi: ${missing.join(', ')}` };
            const m = await prisma.member.update({ where: { id: found[0].id }, data: { role } });
            await audit(ctx.tenant.id, ctx.actorTgId, 'ai.set_role', `${m.name} → ${role}`);
            return { member: m.name, role };
        },
    },

    add_group_to_bot: {
        roles: ['super', 'coach'],
        decl: {
            name: 'add_group_to_bot',
            description: 'Yangi guruhni botga ulash (guruh chat id orqali).',
            parameters: {
                type: 'object',
                properties: { chat_id: S('Guruh chat id, masalan -1001234567890'), title: S('Guruh nomi') },
                required: ['chat_id'],
            },
        },
        run: async (a, ctx) => {
            const res = await addGroup(ctx.tenant.id, String(a.chat_id), String(a.title || ''));
            return { added: res.created, group_id: res.id };
        },
    },

    remove_group_from_bot: {
        roles: ['super', 'coach'],
        decl: {
            name: 'remove_group_from_bot',
            description: "Guruhni botdan uzish (ma'lumotlar saqlanadi, guruh nofaol bo'ladi).",
            parameters: {
                type: 'object',
                properties: { group: S('Guruh nomi/id'), confirm: B('Tasdiqlash') },
                required: ['group', 'confirm'],
            },
        },
        run: async (a, ctx) => {
            if (!a.confirm) return { error: 'Tasdiqlanmadi' };
            const groupId = await resolveGroupId(ctx.tenant.id, a.group);
            if (!groupId) return { error: 'Guruh topilmadi' };
            await prisma.group.update({ where: { id: groupId }, data: { isActive: false } });
            return { removed: true };
        },
    },

    refresh_tables: {
        roles: ['super', 'coach'],
        decl: {
            name: 'refresh_tables',
            description: "Barcha guruhlardagi pinlangan ratsion jadvalini darhol yangilash.",
            parameters: { type: 'object', properties: {} },
        },
        run: async (_a, ctx) => {
            const groups = await prisma.group.findMany({ where: { tenantId: ctx.tenant.id, isActive: true } });
            for (const g of groups) await updateGroupTable(ctx.tenant, g).catch(() => undefined);
            return { refreshed: groups.length };
        },
    },

    // ===== SUPER ADMIN =====
    list_bots: {
        roles: ['super'],
        decl: {
            name: 'list_bots',
            description: 'Platformadagi barcha botlar (tenantlar) va ularning holati. Faqat super admin.',
            parameters: { type: 'object', properties: {} },
        },
        run: async () => {
            const tenants = await prisma.tenant.findMany({ orderBy: { createdAt: 'asc' } });
            return Promise.all(
                tenants.map(async t => ({
                    id: t.id,
                    username: `@${t.botUsername}`,
                    status: t.status,
                    groups: await prisma.group.count({ where: { tenantId: t.id, isActive: true } }),
                    members: await prisma.member.count({ where: { tenantId: t.id, status: 'active' } }),
                    meals_total: await prisma.mealRecord.count({ where: { tenantId: t.id } }),
                })),
            );
        },
    },

    set_bot_status: {
        roles: ['super'],
        decl: {
            name: 'set_bot_status',
            description: "Botni to'xtatish yoki qayta ishga tushirish. Faqat super admin.",
            parameters: {
                type: 'object',
                properties: { bot: S('Bot username yoki tenant id'), status: S('active | paused') },
                required: ['bot', 'status'],
            },
        },
        run: async (a, ctx) => {
            const target = await findTenantByHint(String(a.bot));
            if (!target) return { error: 'Bot topilmadi' };
            const t = a.status === 'paused'
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
                "Bot ma'lumotlarini o'chirish. scope: meals (ovqat tarixi), members (a'zolar), " +
                "mentions (eslatmalar), ai (AI suhbat), outbox (navbat), all (hammasi). Qaytarib bo'lmaydi!",
            parameters: {
                type: 'object',
                properties: {
                    bot: S("Bot username yoki tenant id. Bo'sh — joriy bot."),
                    scope: S('meals | members | mentions | ai | outbox | all'),
                    confirm: B('Tasdiqlash uchun majburiy true'),
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
            const summary = await purgeTenantData(target.id, a.scope as PurgeScope, ctx.actorTgId);
            return { bot: `@${target.botUsername}`, purged: summary };
        },
    },
};

async function findTenantByHint(hint: string) {
    const clean = hint.replace(/^@/, '');
    return (
        (await prisma.tenant.findFirst({ where: { botUsername: { equals: clean, mode: 'insensitive' } } })) ||
        (await prisma.tenant.findUnique({ where: { id: hint } })) ||
        (await prisma.tenant.findUnique({ where: { botId: clean } }))
    );
}

export function declarationsFor(role: Role): FunctionDeclaration[] {
    return Object.values(TOOLS)
        .filter(t => t.roles.includes(role))
        .map(t => t.decl);
}

export async function runTool(name: string, args: any, ctx: ToolContext): Promise<unknown> {
    const tool = TOOLS[name];
    if (!tool) return { error: `Noma'lum funksiya: ${name}` };
    if (!tool.roles.includes(ctx.role)) {
        return { error: `Sizda "${name}" uchun ruxsat yo'q (rol: ${ctx.role})` };
    }
    try {
        return await tool.run(args ?? {}, ctx);
    } catch (e: any) {
        log.error('ai-tool', `${name} xatosi`, e);
        return { error: e?.message ? String(e.message) : 'Ichki xato' };
    }
}

export function toolNames(role: Role): string[] {
    return declarationsFor(role).map(d => d.name);
}
