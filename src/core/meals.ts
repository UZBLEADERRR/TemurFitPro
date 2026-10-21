import type { Tenant } from '../generated/platform';
import { hhmmToMinutes } from './time';

export const MEAL_TYPES = ['nonushta', 'tushlik', 'kechki'] as const;
export type MealType = (typeof MEAL_TYPES)[number];

export const MEAL_LABELS: Record<MealType, string> = {
    nonushta: 'Nonushta',
    tushlik: 'Tushlik',
    kechki: 'Kechki ovqat',
};

export const MEAL_SHORT: Record<MealType, string> = {
    nonushta: 'N',
    tushlik: 'T',
    kechki: 'K',
};

export function isMealType(v: string): v is MealType {
    return (MEAL_TYPES as readonly string[]).includes(v);
}

function parseWords(csv: string): string[] {
    return csv.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}

/// Rasm izohidan (caption) ovqat turini aniqlash
export function detectMealType(tenant: Tenant, caption: string): MealType | null {
    const text = caption.toLowerCase();
    const buckets: Array<[MealType, string[]]> = [
        ['nonushta', parseWords(tenant.breakfastWords)],
        ['tushlik', parseWords(tenant.lunchWords)],
        ['kechki', parseWords(tenant.dinnerWords)],
    ];
    for (const [type, words] of buckets) {
        if (words.some(w => text.includes(w))) return type;
    }
    return null;
}

// ============ OVQAT VAQTLARI ============
//
// Vaqt ikki qavatli:
//   1. Botning umumiy vaqti (tenant) — barcha uchun standart
//   2. A'zoning SHAXSIY vaqti — u o'zi tanlagan bo'lsa shu ustun turadi
//
// Koreyadagi odam bilan O'zbekistondagi odamning kun tartibi bir xil emas;
// vaqt mintaqasi lokatsiyadan aniqlanadi, soatlarni esa odamning o'zi
// tanlaydi. Eslatma ham, "kech qoldi" hisobi ham shu yerdan boshlanadi.

/// Shaxsiy vaqt qo'yilishi mumkin bo'lgan a'zo.
/// Faqat kerakli maydonlar — test va eski chaqiruvlar uchun qulay.
export interface MemberTimes {
    breakfastTime?: string | null;
    lunchTime?: string | null;
    dinnerTime?: string | null;
}

export type MealTimes = Record<MealType, string>;

/// Shu a'zo uchun amaldagi uchta vaqt ("HH:mm").
/// A'zo qo'ymagan bo'lsa botning umumiy vaqti ishlatiladi.
export function mealTimesFor(tenant: Tenant, member?: MemberTimes | null): MealTimes {
    return {
        nonushta: member?.breakfastTime || tenant.breakfastTime,
        tushlik: member?.lunchTime || tenant.lunchTime,
        kechki: member?.dinnerTime || tenant.dinnerTime,
    };
}

/// A'zo vaqtni o'zi tanlaganmi (sozlamalarda ko'rsatish uchun)
export function hasOwnTimes(member?: MemberTimes | null): boolean {
    return !!(member?.breakfastTime || member?.lunchTime || member?.dinnerTime);
}

export function mealTargetMinutes(tenant: Tenant, meal: MealType, member?: MemberTimes | null): number {
    return hhmmToMinutes(mealTimesFor(tenant, member)[meal]);
}

/// Eslatma oynasining yopilish vaqti — keyingi ovqat vaqti (kechki uchun kun oxiri).
///
/// Vaqtlar shaxsiy bo'lgani uchun tartib buzilishi mumkin (masalan nonushta
/// 10:00, tushlik 09:00 deb qo'yilsa). Shunda oyna manfiy bo'lib, eslatma
/// umuman ketmay qolardi — shu sabab keyingi vaqt kechroq bo'lgandagina
/// chegara qilinadi, aks holda kun oxirigacha ochiq qoladi.
export function mealWindowEnd(tenant: Tenant, meal: MealType, member?: MemberTimes | null): number {
    const END_OF_DAY = 23 * 60 + 59;
    const times = mealTimesFor(tenant, member);
    const start = hhmmToMinutes(times[meal]);

    const next = meal === 'nonushta' ? times.tushlik : meal === 'tushlik' ? times.kechki : null;
    if (!next) return END_OF_DAY;

    const nextMin = hhmmToMinutes(next);
    return nextMin > start ? nextMin : END_OF_DAY;
}

/// "HH:mm" to'g'rimi (00:00 — 23:59)
export function isValidTime(v: string): boolean {
    return /^([01]\d|2[0-3]):[0-5]\d$/.test(v.trim());
}

/// "9", "9:5", "09.30", "9 30" kabilarni "09:30" ga keltirish.
/// Odamlar vaqtni har xil yozadi — rad etishdan ko'ra tushunib olgan yaxshi.
export function normalizeTime(raw: string): string | null {
    const t = raw.trim().replace(/[.\s]+/g, ':');
    const m = /^(\d{1,2})(?::(\d{1,2}))?$/.exec(t);
    if (!m) return null;
    const h = Number(m[1]);
    const min = m[2] === undefined ? 0 : Number(m[2]);
    if (h > 23 || min > 59) return null;
    return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}
