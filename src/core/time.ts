import { toZonedTime, format } from 'date-fns-tz';
import { subDays, addDays } from 'date-fns';

export const DEFAULT_TZ = 'Asia/Tashkent';

/// Berilgan vaqt mintaqasidagi bugungi sana (yyyy-MM-dd)
export function todayIn(timezone: string, base: Date = new Date()): string {
    const tz = safeTz(timezone);
    return format(toZonedTime(base, tz), 'yyyy-MM-dd', { timeZone: tz });
}

/// Bugundan n kun oldingi sana
export function daysAgoIn(timezone: string, n: number, base: Date = new Date()): string {
    const tz = safeTz(timezone);
    return format(subDays(toZonedTime(base, tz), n), 'yyyy-MM-dd', { timeZone: tz });
}

/// Oxirgi n kunning sanalari (bugun ham kiradi), eskidan yangiga
export function lastNDates(timezone: string, n: number, base: Date = new Date()): string[] {
    const out: string[] = [];
    for (let i = n - 1; i >= 0; i--) out.push(daysAgoIn(timezone, i, base));
    return out;
}

/// Ikki sana orasidagi barcha sanalar (ikkalasi ham kiradi)
export function dateRange(from: string, to: string): string[] {
    const out: string[] = [];
    let cur = new Date(`${from}T00:00:00Z`);
    const end = new Date(`${to}T00:00:00Z`);
    let guard = 0;
    while (cur <= end && guard++ < 800) {
        out.push(cur.toISOString().slice(0, 10));
        cur = addDays(cur, 1);
    }
    return out;
}

/// Mahalliy vaqtdagi daqiqalar soni (0-1439)
export function localMinutes(timezone: string, base: Date = new Date()): number {
    const local = toZonedTime(base, safeTz(timezone));
    return local.getHours() * 60 + local.getMinutes();
}

/// "HH:mm" -> daqiqa
export function hhmmToMinutes(hhmm: string): number {
    const [h, m] = hhmm.split(':').map(Number);
    if (Number.isNaN(h) || Number.isNaN(m)) return 0;
    return h * 60 + m;
}

export function minutesToHhmm(min: number): string {
    const h = Math.floor(min / 60) % 24;
    const m = min % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/// Foydalanuvchi mahalliy vaqtidagi "yyyy-MM-dd HH:mm" ni UTC Date'ga aylantirish.
/// AI "ertaga soat 9 da yubor" deganda kerak bo'ladi.
export function localDateTimeToUtc(dateStr: string, hhmm: string, timezone: string): Date {
    const tz = safeTz(timezone);
    const naive = new Date(`${dateStr}T${hhmm}:00Z`);
    // tz'dagi o'sha lahzaning UTC'dan farqini topamiz va teskarisiga suramiz
    const offsetMs = toZonedTime(naive, tz).getTime() - naive.getTime();
    return new Date(naive.getTime() - offsetMs);
}

export function safeTz(timezone: string | null | undefined): string {
    if (!timezone) return DEFAULT_TZ;
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
        return timezone;
    } catch {
        return DEFAULT_TZ;
    }
}

export function formatIn(date: Date, timezone: string, pattern = 'dd.MM.yyyy HH:mm'): string {
    const tz = safeTz(timezone);
    return format(toZonedTime(date, tz), pattern, { timeZone: tz });
}
