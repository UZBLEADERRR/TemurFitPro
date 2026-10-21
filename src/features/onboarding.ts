import { Markup } from 'telegraf';
import type { Context } from 'telegraf';
import type { Tenant } from '../generated/platform';
import type { Member } from '../generated/tenant';
import type { TenantClient } from '../core/db';
import { MEAL_TYPES, MEAL_LABELS, MealType, mealTimesFor, normalizeTime, hasOwnTimes } from '../core/meals';
import { esc } from '../core/telegram';
import { setTenantState, clearTenantState } from '../bots/session';

// A'zoning boshlang'ich sozlashi: vaqt mintaqasi + uchta shaxsiy ovqat vaqti.
//
// Nega kerak: Koreyadagi a'zo bilan O'zbekistondagi a'zo bitta guruhda
// bo'lishi mumkin, lekin ularning kun tartibi bir xil emas. Mintaqa
// lokatsiyadan avtomatik aniqlanadi, soatlarni esa odamning o'zi tanlaydi.
//
// Oqim BotSession da yuritiladi, shuning uchun bot qayta ishga tushsa ham
// yarim qolgan sozlash joyidan davom etadi.

export const SETUP_LOCATION = 'setup:location';
export const SETUP_TIME = 'setup:time';

/// Har bir ovqat uchun tavsiya etiladigan soatlar
const SUGGESTIONS: Record<MealType, string[]> = {
    nonushta: ['06:00', '07:00', '08:00', '09:00'],
    tushlik: ['12:00', '13:00', '14:00', '15:00'],
    kechki: ['18:00', '19:00', '20:00', '21:00'],
};

const MEAL_ICON: Record<MealType, string> = {
    nonushta: '🌅',
    tushlik: '🌞',
    kechki: '🌙',
};

export function nextMeal(meal: MealType): MealType | null {
    const i = MEAL_TYPES.indexOf(meal);
    return i >= 0 && i + 1 < MEAL_TYPES.length ? MEAL_TYPES[i + 1] : null;
}

/// Lokatsiya so'rash. Telegram tugmasi faqat oddiy (reply) klaviaturada
/// ishlaydi — inline tugmadan lokatsiya yuborib bo'lmaydi.
export function locationKeyboard() {
    return Markup.keyboard([
        [Markup.button.locationRequest('📍 Joylashuvimni yuborish')],
        ["⏭ Keyinroq"],
    ])
        .resize()
        .oneTime();
}

export function locationPrompt(tenant: Tenant): string {
    return [
        '👋 <b>Xush kelibsiz!</b>',
        '',
        'Bir daqiqalik sozlash — shundan keyin eslatmalar <b>sizning</b> vaqtingizda keladi.',
        '',
        '<b>1-qadam.</b> Joylashuvingizni yuboring — vaqt mintaqangizni aniqlab olaman.',
        '',
        `<i>Yubormasangiz ham bo'ladi, u holda ${esc(tenant.timezone)} ishlatiladi.</i>`,
        "<i>Joylashuv saqlanmaydi — faqat mintaqa aniqlanadi.</i>",
    ].join('\n');
}

/// Vaqt tanlash ekrani
export function timePrompt(tenant: Tenant, member: Member, meal: MealType, step: number): string {
    const current = mealTimesFor(tenant, member)[meal];
    return [
        `${MEAL_ICON[meal]} <b>${MEAL_LABELS[meal]} vaqtingiz</b>`,
        `<i>${step}/3-qadam · vaqt mintaqangiz: ${esc(member.timezone)}</i>`,
        '',
        'Odatda soat nechada ovqatlanasiz?',
        '',
        `<i>Hozir: ${esc(current)}. Pastdan tanlang yoki o'zingiz yozing (masalan <code>08:30</code>).</i>`,
    ].join('\n');
}

/// DIQQAT: callback ma'lumoti ":" bo'yicha bo'linadi, shuning uchun vaqt
/// "0800" ko'rinishida uzatiladi — "08:00" bo'lsa qator ikkiga bo'linib ketardi.
export function packTime(hhmm: string): string {
    return hhmm.replace(':', '');
}

export function unpackTime(packed: string): string | null {
    if (packed === 'skip') return null;
    const m = /^([01]\d|2[0-3])([0-5]\d)$/.exec(packed);
    return m ? `${m[1]}:${m[2]}` : null;
}

export function timeKeyboard(meal: MealType) {
    const opts = SUGGESTIONS[meal];
    const btn = (t: string) => Markup.button.callback(t, `m:time:${meal}:${packTime(t)}`);
    return Markup.inlineKeyboard([
        opts.slice(0, 2).map(btn),
        opts.slice(2).map(btn),
        [Markup.button.callback("⏭ Standart vaqtda qolsin", `m:time:${meal}:skip`)],
    ]);
}

/// Sozlashning keyingi qadamiga o'tish (yoki tugatish)
export async function askTime(
    ctx: Context,
    tenant: Tenant,
    member: Member,
    meal: MealType,
    reply: (ctx: Context, text: string, kb?: any) => Promise<void>,
): Promise<void> {
    await setTenantState(tenant.botId, String(ctx.chat!.id), SETUP_TIME, { meal });
    const step = MEAL_TYPES.indexOf(meal) + 1;
    await reply(ctx, timePrompt(tenant, member, meal, step), timeKeyboard(meal));
}

/// Tanlangan vaqtni yozish. skip bo'lsa shaxsiy vaqt qo'yilmaydi.
export async function saveTime(
    db: TenantClient,
    memberId: string,
    meal: MealType,
    value: string | null,
): Promise<Member> {
    const field = meal === 'nonushta' ? 'breakfastTime' : meal === 'tushlik' ? 'lunchTime' : 'dinnerTime';
    return db.member.update({ where: { id: memberId }, data: { [field]: value } });
}

export async function finishSetup(db: TenantClient, memberId: string): Promise<Member> {
    return db.member.update({ where: { id: memberId }, data: { setupDone: true } });
}

/// Sozlash tugagandagi xulosa
export function setupSummary(tenant: Tenant, member: Member): string {
    const times = mealTimesFor(tenant, member);
    return [
        '✅ <b>Tayyor!</b>',
        '',
        `🌍 Vaqt mintaqangiz: <b>${esc(member.timezone)}</b>`,
        `🌅 ${MEAL_LABELS.nonushta}: <b>${esc(times.nonushta)}</b>`,
        `🌞 ${MEAL_LABELS.tushlik}: <b>${esc(times.tushlik)}</b>`,
        `🌙 ${MEAL_LABELS.kechki}: <b>${esc(times.kechki)}</b>`,
        '',
        hasOwnTimes(member)
            ? "Eslatmalar shu vaqtlarda keladi. O'zgartirish: ⏰ <b>Mening vaqtlarim</b>."
            : "Botning umumiy vaqtlari ishlatiladi. O'zingizniki kerak bo'lsa: ⏰ <b>Mening vaqtlarim</b>.",
        '',
        'Endi ratsioningizni guruhga hashtag bilan yuboring:',
        '<code>#nonushta</code> · <code>#tushlik</code> · <code>#kechki</code>',
    ].join('\n');
}

/// Qo'lda yozilgan vaqtni o'qish. Tushunmasa null.
export function parseTypedTime(text: string): string | null {
    return normalizeTime(text);
}

export async function abortSetup(botId: string, chatId: string): Promise<void> {
    await clearTenantState(botId, chatId);
}
