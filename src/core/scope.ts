import type { TenantClient } from './db';
import { isCoachRole, type Role } from './roles';
import { LIVE_GROUP } from './groups';

// Kim nimani ko'radi.
//
// Ikki xil murabbiy bor:
//
//   GLOBAL murabbiy  — Member.role = 'coach' yoki 'owner'.
//                      Botdagi BARCHA guruhlarni ko'radi va boshqaradi.
//
//   GURUH murabbiysi — GroupMember.role = 'coach'.
//                      FAQAT o'ziga biriktirilgan guruh(lar)ni ko'radi.
//
// Shu tufayli bitta botda "Ertalabki guruh"ni bir murabbiy, "Kechki guruh"ni
// boshqasi yuritishi mumkin va ular bir-birining a'zolarini ko'rmaydi.

/// Ko'rish doirasi.
/// groupIds = null  → cheklov yo'q, hamma guruh ko'rinadi
/// groupIds = []    → hech narsa (murabbiy emas)
export interface Scope {
    role: Role;
    /// null — barcha guruhlar
    groupIds: string[] | null;
    /// Murabbiylik huquqi bormi (global yoki hech bo'lmasa bitta guruhda)
    isManager: boolean;
    /// Faqat ayrim guruhlarga biriktirilganmi
    isGroupCoach: boolean;
}

export const FULL_SCOPE: Scope = { role: 'super', groupIds: null, isManager: true, isGroupCoach: false };

export const NO_SCOPE: Scope = { role: 'member', groupIds: [], isManager: false, isGroupCoach: false };

/// Shu odam murabbiy bo'lgan guruhlarning id lari.
export async function coachGroupIds(db: TenantClient, memberId: string): Promise<string[]> {
    const links = await db.groupMember.findMany({
        where: { memberId, role: 'coach', group: LIVE_GROUP },
        select: { groupId: true },
    });
    return links.map(l => l.groupId);
}

/// Odamning ko'rish doirasini aniqlash.
///
/// superAdmin  — ona botdagi platforma admini (hammani ko'radi)
/// member      — shu botdagi a'zo yozuvi (bo'lmasligi ham mumkin)
export async function scopeFor(
    db: TenantClient,
    member: { id: string; role: string } | null,
    superAdmin: boolean,
): Promise<Scope> {
    if (superAdmin) return FULL_SCOPE;
    if (!member) return NO_SCOPE;

    // Global murabbiy — cheklovsiz
    if (isCoachRole(member.role)) {
        return { role: 'coach', groupIds: null, isManager: true, isGroupCoach: false };
    }

    // Guruh murabbiysi — faqat o'z guruhlari
    const groupIds = await coachGroupIds(db, member.id);
    if (groupIds.length) {
        return { role: 'coach', groupIds, isManager: true, isGroupCoach: true };
    }

    return NO_SCOPE;
}

/// Shu guruh doiraga kiradimi.
export function allowsGroup(scope: Scope, groupId: string): boolean {
    if (!scope.isManager) return false;
    return scope.groupIds === null || scope.groupIds.includes(groupId);
}

/// So'ralgan guruhni doiraga moslash.
/// Doiradan tashqaridagi guruh so'ralsa — undefined qaytadi (rad etiladi).
export function resolveGroupFilter(
    scope: Scope,
    requestedGroupId?: string | null,
): { groupId: string | null } | undefined {
    if (!requestedGroupId) return { groupId: null };
    if (!allowsGroup(scope, requestedGroupId)) return undefined;
    return { groupId: requestedGroupId };
}
