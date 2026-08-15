import { prisma, tenantDb } from '../core/db';

/// Ko'p bosqichli dialoglar holati bazada saqlanadi — Railway restart qilsa ham yo'qolmaydi.
export interface SessionState<T = Record<string, unknown>> {
    state: string;
    payload: T;
}

const IDLE: SessionState = { state: 'idle', payload: {} };

function parse(row: { state: string; payload: string } | null): SessionState {
    if (!row) return IDLE;
    try {
        return { state: row.state, payload: JSON.parse(row.payload) };
    } catch {
        return { state: row.state, payload: {} };
    }
}

// ---------- Ona bot ----------

export async function getControlState(chatId: string): Promise<SessionState> {
    return parse(await prisma.controlSession.findUnique({ where: { chatId } }));
}

export async function setControlState(
    chatId: string,
    state: string,
    payload: Record<string, unknown> = {},
): Promise<void> {
    const data = { state, payload: JSON.stringify(payload) };
    await prisma.controlSession.upsert({ where: { chatId }, create: { chatId, ...data }, update: data });
}

export async function clearControlState(chatId: string): Promise<void> {
    await prisma.controlSession.delete({ where: { chatId } }).catch(() => undefined);
}

// ---------- Mijoz boti ----------

export async function getTenantState(botId: string, chatId: string): Promise<SessionState> {
    const db = await tenantDb(botId);
    return parse(await db.botSession.findUnique({ where: { chatId } }));
}

export async function setTenantState(
    botId: string,
    chatId: string,
    state: string,
    payload: Record<string, unknown> = {},
): Promise<void> {
    const db = await tenantDb(botId);
    const data = { state, payload: JSON.stringify(payload) };
    await db.botSession.upsert({ where: { chatId }, create: { chatId, ...data }, update: data });
}

export async function clearTenantState(botId: string, chatId: string): Promise<void> {
    const db = await tenantDb(botId);
    await db.botSession.delete({ where: { chatId } }).catch(() => undefined);
}
