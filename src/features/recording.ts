import type { Context } from 'telegraf';
import type { Tenant, Member, Group } from '@prisma/client';
import { prisma } from '../core/db';
import { detectMealType, mealTargetMinutes, MEAL_LABELS, MealType } from '../core/meals';
import { todayIn, daysAgoIn, localMinutes, hhmmToMinutes, safeTz } from '../core/time';
import { refreshTablesForMember } from './table';
import { getBotByTenant } from '../core/registry';
import { tgError } from '../core/telegram';
import { log } from '../core/logger';

export interface RecordResult {
    meal: MealType;
    date: string;
    status: 'on_time' | 'late';
}

/// Ovqat qaydini yozish. Sana va "kech qoldi"mi — a'zoning O'Z vaqt mintaqasida hisoblanadi.
export async function recordMeal(
    tenant: Tenant,
    member: Member,
    group: Group | null,
    meal: MealType,
    opts: { photoFileId?: string; messageId?: number; caption?: string } = {},
): Promise<RecordResult> {
    const tz = safeTz(member.timezone);
    let date = todayIn(tz);
    const nowMin = localMinutes(tz);
    const targetMin = mealTargetMinutes(tenant, meal);
    const breakfastMin = hhmmToMinutes(tenant.breakfastTime);

    let status: 'on_time' | 'late' = 'on_time';

    if (meal === 'kechki' && nowMin < breakfastMin) {
        // Yarim tundan keyin yuborilgan kechki ovqat — kechagi kunga yoziladi
        date = daysAgoIn(tz, 1);
        status = 'late';
    } else if (nowMin > targetMin + tenant.graceMinutes) {
        status = 'late';
    }

    await prisma.mealRecord.upsert({
        where: { memberId_date_mealType: { memberId: member.id, date, mealType: meal } },
        create: {
            tenantId: tenant.id,
            memberId: member.id,
            groupId: group?.id ?? null,
            date,
            mealType: meal,
            timeSent: new Date(),
            status,
            photoFileId: opts.photoFileId,
            messageId: opts.messageId,
            caption: opts.caption?.slice(0, 400),
        },
        update: {
            timeSent: new Date(),
            status,
            groupId: group?.id ?? null,
            photoFileId: opts.photoFileId,
            messageId: opts.messageId,
            caption: opts.caption?.slice(0, 400),
        },
    });

    await clearMentions(tenant, member.id, meal, date);
    void refreshTablesForMember(tenant, member.id).catch(e =>
        log.warn('recording', `jadval yangilanmadi: ${tgError(e)}`),
    );

    return { meal, date, status };
}

/// Ovqat kelgach, o'sha ovqat uchun yuborilgan eslatma xabarlarini guruhdan o'chirish
async function clearMentions(tenant: Tenant, memberId: string, meal: MealType, date: string): Promise<void> {
    if (!tenant.autoDeleteReminders) return;
    const bot = getBotByTenant(tenant.id);
    const mentions = await prisma.mention.findMany({
        where: { memberId, mealType: meal, date },
        include: { group: true },
    });
    for (const m of mentions) {
        if (bot) {
            try {
                await bot.telegram.deleteMessage(m.group.chatId, m.messageId);
            } catch {
                /* xabar allaqachon o'chirilgan bo'lishi mumkin */
            }
        }
        await prisma.mention.delete({ where: { id: m.id } }).catch(() => undefined);
    }
}

/// Guruhdagi rasm/hujjat xabarini qayta ishlash. Qayd etilgan bo'lsa true qaytaradi.
export async function handleGroupMeal(ctx: Context, tenant: Tenant, group: Group): Promise<boolean> {
    const msg = ctx.message as any;
    if (!msg || !ctx.from) return false;

    const caption: string = msg.caption || msg.text || '';
    const meal = detectMealType(tenant, caption);
    if (!meal) return false;

    const hasPhoto = Array.isArray(msg.photo) && msg.photo.length > 0;
    const hasVideo = !!msg.video;
    if (tenant.requirePhoto && !hasPhoto && !hasVideo) {
        return false; // Faqat matnli hashtag — qayd etilmaydi
    }

    const telegramId = String(ctx.from.id);
    let member = await prisma.member.findUnique({
        where: { tenantId_telegramId: { tenantId: tenant.id, telegramId } },
    });

    if (!member) {
        // Guruhda ko'ringan yangi odamni avtomatik ro'yxatga olamiz —
        // eski botda /start majburiy edi, bu esa ko'p qaydlarni yo'qotardi.
        member = await prisma.member.create({
            data: {
                tenantId: tenant.id,
                telegramId,
                name: [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') || 'Foydalanuvchi',
                username: ctx.from.username ?? null,
                timezone: tenant.timezone,
            },
        });
    }

    await prisma.groupMember.upsert({
        where: { groupId_memberId: { groupId: group.id, memberId: member.id } },
        create: { groupId: group.id, memberId: member.id },
        update: {},
    });

    const photoFileId = hasPhoto ? msg.photo[msg.photo.length - 1].file_id : msg.video?.file_id;
    const result = await recordMeal(tenant, member, group, meal, {
        photoFileId,
        messageId: msg.message_id,
        caption,
    });

    const mark = result.status === 'late' ? '🟡 Kech, lekin qabul qilindi' : '🟢 Qabul qilindi';
    try {
        await ctx.reply(`${mark} — ${MEAL_LABELS[meal]} 💪`, {
            reply_parameters: { message_id: msg.message_id },
        });
    } catch (e) {
        log.warn('recording', `tasdiq yuborilmadi: ${tgError(e)}`);
    }

    return true;
}
