import type { Context } from 'telegraf';
import type { Tenant } from '../generated/platform';
import type { Member, Group } from '../generated/tenant';
import type { TenantClient } from '../core/db';
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
    db: TenantClient,
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

    await db.mealRecord.upsert({
        where: { memberId_date_mealType: { memberId: member.id, date, mealType: meal } },
        create: {
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

    await clearMentions(db, tenant, member.id, meal, date);
    void refreshTablesForMember(tenant, member.id).catch(e =>
        log.warn('recording', `jadval yangilanmadi: ${tgError(e)}`),
    );

    return { meal, date, status };
}

/// Ovqat kelgach, o'sha ovqat uchun yuborilgan eslatma xabarlarini guruhdan o'chirish
async function clearMentions(
    db: TenantClient,
    tenant: Tenant,
    memberId: string,
    meal: MealType,
    date: string,
): Promise<void> {
    if (!tenant.autoDeleteReminders) return;
    const bot = getBotByTenant(tenant.id);
    const mentions = await db.mention.findMany({
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
        await db.mention.delete({ where: { id: m.id } }).catch(() => undefined);
    }
}

/// Guruhdagi rasm/video xabarini qayta ishlash. Qayd etilgan bo'lsa true qaytaradi.
export async function handleGroupMeal(
    ctx: Context,
    db: TenantClient,
    tenant: Tenant,
    group: Group,
): Promise<boolean> {
    const msg = ctx.message as any;
    if (!msg || !ctx.from) return false;

    const caption: string = msg.caption || msg.text || '';
    const meal = detectMealType(tenant, caption);
    if (!meal) return false;

    const hasPhoto = Array.isArray(msg.photo) && msg.photo.length > 0;
    const hasVideo = !!msg.video;
    if (tenant.requirePhoto && !hasPhoto && !hasVideo) return false;

    const telegramId = String(ctx.from.id);
    let member = await db.member.findUnique({ where: { telegramId } });

    if (!member) {
        // Guruhda ko'ringan yangi odamni avtomatik ro'yxatga olamiz —
        // /start majburiy bo'lsa ko'p qaydlar yo'qolardi.
        const name = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') || 'Foydalanuvchi';
        member = await db.member.create({
            data: {
                telegramId,
                name,
                nameLc: name.toLowerCase(),
                username: ctx.from.username ?? null,
                timezone: tenant.timezone,
            },
        });
    }

    await db.groupMember.upsert({
        where: { groupId_memberId: { groupId: group.id, memberId: member.id } },
        create: { groupId: group.id, memberId: member.id },
        update: {},
    });

    const photoFileId = hasPhoto ? msg.photo[msg.photo.length - 1].file_id : msg.video?.file_id;
    const result = await recordMeal(db, tenant, member, group, meal, {
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
