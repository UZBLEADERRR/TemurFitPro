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

export function mealTargetMinutes(tenant: Tenant, meal: MealType): number {
    if (meal === 'nonushta') return hhmmToMinutes(tenant.breakfastTime);
    if (meal === 'tushlik') return hhmmToMinutes(tenant.lunchTime);
    return hhmmToMinutes(tenant.dinnerTime);
}

/// Eslatma oynasining yopilish vaqti — keyingi ovqat vaqti (kechki uchun kun oxiri)
export function mealWindowEnd(tenant: Tenant, meal: MealType): number {
    if (meal === 'nonushta') return hhmmToMinutes(tenant.lunchTime);
    if (meal === 'tushlik') return hhmmToMinutes(tenant.dinnerTime);
    return 23 * 60 + 59;
}
