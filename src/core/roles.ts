/// Foydalanuvchi roli:
///   super  — platforma egasi (ona botga kira oladi)
///   coach  — murabbiy yoki bot egasi (o'z botini boshqaradi)
///   member — oddiy a'zo
export type Role = 'super' | 'coach' | 'member';

export function isManager(role: Role): boolean {
    return role === 'super' || role === 'coach';
}

export function isCoachRole(memberRole: string): boolean {
    return memberRole === 'coach' || memberRole === 'owner';
}
