/// Guruhning ish holati.
///
/// Guruh ikki shartga birdek bog'liq:
///   isActive — bot hozir guruh ichidami (chiqarib yuborilsa false)
///   status   — super admin qarori
///
/// Guruhlarni FAQAT super admin qabul qiladi. Bot guruhga qo'shilganda
/// "pending" bo'lib turadi va tasdiqlangunicha hech narsa qayd etilmaydi.

export type GroupStatus = 'pending' | 'approved' | 'rejected';

/// Ishlayotgan guruhlar uchun Prisma filtri — barcha so'rovlarda shu ishlatiladi
export const LIVE_GROUP = { isActive: true, status: 'approved' } as const;

/// Tasdiq kutayotganlar (bot hali ichida)
export const PENDING_GROUP = { isActive: true, status: 'pending' } as const;

export function isLive(g: { isActive: boolean; status: string }): boolean {
    return g.isActive && g.status === 'approved';
}

export function statusBadge(g: { isActive: boolean; status: string }): string {
    if (!g.isActive) return '🚪 bot chiqarilgan';
    if (g.status === 'pending') return '⏳ tasdiq kutmoqda';
    if (g.status === 'rejected') return '❌ rad etilgan';
    return '✅ faol';
}
