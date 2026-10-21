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

/// A'zo uchun shart: hech bo'lmasa BITTA jonli guruhda turibdimi.
///
/// Buni HAR BIR a'zo ro'yxatiga qo'yish shart. Guruh o'chirilganda
/// GroupMember qatorlari kaskad bilan ketadi, lekin Member qatori qoladi —
/// ya'ni odam hech qaysi guruhda bo'lmay turib bazada yotaveradi.
/// Shu shartsiz u reyting va a'zolar ro'yxatida 0% bo'lib ko'rinib turadi.
export const IN_LIVE_GROUP = { groups: { some: { group: LIVE_GROUP } } } as const;

export function isLive(g: { isActive: boolean; status: string }): boolean {
    return g.isActive && g.status === 'approved';
}

export function statusBadge(g: { isActive: boolean; status: string }): string {
    if (!g.isActive) return '🚪 bot chiqarilgan';
    if (g.status === 'pending') return '⏳ tasdiq kutmoqda';
    if (g.status === 'rejected') return '❌ rad etilgan';
    return '✅ faol';
}
