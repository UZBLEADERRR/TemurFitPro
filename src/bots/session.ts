import { prisma } from '../core/db';

/// Ko'p bosqichli dialoglar holati DB'da saqlanadi — Railway restart qilsa ham yo'qolmaydi.
export interface SessionState<T = Record<string, unknown>> {
    state: string;
    payload: T;
}

export async function getState(scope: string, chatId: string): Promise<SessionState> {
    const row = await prisma.botSession.findUnique({ where: { scope_chatId: { scope, chatId } } });
    if (!row) return { state: 'idle', payload: {} };
    let payload: Record<string, unknown> = {};
    try {
        payload = JSON.parse(row.payload);
    } catch {
        payload = {};
    }
    return { state: row.state, payload };
}

export async function setState(
    scope: string,
    chatId: string,
    state: string,
    payload: Record<string, unknown> = {},
    tenantId?: string,
): Promise<void> {
    await prisma.botSession.upsert({
        where: { scope_chatId: { scope, chatId } },
        create: { scope, chatId, state, payload: JSON.stringify(payload), tenantId: tenantId ?? null },
        update: { state, payload: JSON.stringify(payload) },
    });
}

export async function clearState(scope: string, chatId: string): Promise<void> {
    await prisma.botSession
        .delete({ where: { scope_chatId: { scope, chatId } } })
        .catch(() => undefined);
}
