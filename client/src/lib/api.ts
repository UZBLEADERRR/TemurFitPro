import { tg } from './telegram';

/// Tenant id URL'dan keladi: /app?t=<tenantId> (bot tugmasi shunday ochadi)
export function tenantId(): string {
    const url = new URL(window.location.href);
    return url.searchParams.get('t') || tg()?.initDataUnsafe?.start_param || '';
}

class ApiError extends Error {
    constructor(message: string, readonly status: number) {
        super(message);
    }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const t = tenantId();
    const sep = path.includes('?') ? '&' : '?';
    const res = await fetch(`/api${path}${sep}t=${encodeURIComponent(t)}`, {
        ...init,
        headers: {
            'content-type': 'application/json',
            'x-init-data': tg()?.initData ?? '',
            'x-tenant-id': t,
            ...(init.headers ?? {}),
        },
    });

    if (!res.ok) {
        const body = await res.json().catch(() => ({ error: `Xato ${res.status}` }));
        throw new ApiError(body.error || `Xato ${res.status}`, res.status);
    }
    return res.json() as Promise<T>;
}

export const api = {
    me: () => request<Me>('/me'),
    board: (date: string, group?: string) =>
        request<Board>(`/board?date=${date}${group ? `&group=${group}` : ''}`),
    groups: () => request<GroupInfo[]>('/groups'),
    stats: (days: number, group?: string) =>
        request<Stats>(`/stats?days=${days}${group ? `&group=${group}` : ''}`),
    inactive: (days: number) => request<InactiveRow[]>(`/inactive?days=${days}`),
    members: (group?: string) => request<MemberBrief[]>(`/members${group ? `?group=${group}` : ''}`),
    member: (id: string, days = 14) => request<MemberDetail>(`/member/${id}?days=${days}`),
    streak: (member?: string) => request<Streak>(`/streak${member ? `?member=${member}` : ''}`),
    settings: () => request<Settings>('/settings'),
    saveSettings: (body: Partial<Settings>) =>
        request<{ ok: boolean }>('/settings', { method: 'POST', body: JSON.stringify(body) }),
    business: () => request<BusinessInfo>('/business'),
};

// ===== Tiplar =====
export type MealKey = 'nonushta' | 'tushlik' | 'kechki';
export type MealStatus = 'on_time' | 'late' | 'missing';
export type Role = 'super' | 'coach' | 'member';

export interface Me {
    role: Role;
    telegramId: string;
    member: { id: string; name: string; timezone: string; role: string } | null;
    tenant: {
        id: string;
        agentName: string;
        botUsername: string;
        timezone: string;
        meals: Record<MealKey, string>;
    };
}

export interface BoardMember {
    id: string;
    name: string;
    role: string;
    timezone: string;
    groups: { id: string; title: string }[];
    meals: Record<MealKey, MealStatus>;
}

export interface Board {
    date: string;
    members: BoardMember[];
}

export interface GroupInfo {
    id: string;
    title: string;
    members: number;
}

export interface StatsRow {
    id: string;
    name: string;
    rate: number;
    done: number;
    missed: number;
    late: number;
}

export interface Stats {
    rows: StatsRow[];
    days: number;
    from: string;
    to: string;
}

export interface MemberBrief {
    id: string;
    name: string;
    username: string | null;
    role: string;
    status: string;
    timezone: string;
    groups: string[];
}

export interface InactiveRow {
    id: string;
    name: string;
    lastMealDate: string | null;
    daysSince: number | null;
    groups: string[];
}

export interface MemberDetail {
    member: { id: string; name: string; timezone: string; role: string };
    days: { date: string; meals: { meal: MealKey; status: string; at: string | null }[] }[];
    total: number;
    expected: number;
}

export interface Streak {
    streak: number;
    days: { date: string; done: number; late: number }[];
}

export interface Settings {
    agentName: string;
    coachStyle: string;
    timezone: string;
    breakfastTime: string;
    lunchTime: string;
    dinnerTime: string;
    graceMinutes: number;
    reminderInterval: number;
    maxReminders: number;
    dailyTableHour: number;
    requirePhoto: boolean;
    autoDeleteReminders: boolean;
    breakfastWords: string;
    lunchWords: string;
    dinnerWords: string;
}

export interface BusinessInfo {
    ready: boolean;
    connection: { user: string; canReply: boolean; enabled: boolean } | null;
}

export const MEALS: { key: MealKey; label: string; short: string }[] = [
    { key: 'nonushta', label: 'Nonushta', short: 'N' },
    { key: 'tushlik', label: 'Tushlik', short: 'T' },
    { key: 'kechki', label: 'Kechki', short: 'K' },
];
