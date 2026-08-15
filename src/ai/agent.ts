import type { Tenant } from '@prisma/client';
import { prisma } from '../core/db';
import { generate, transcribeAudio, hasGemini, GeminiError, Content } from './gemini';
import { declarationsFor, runTool, Role, ToolContext } from './tools';
import { systemPrompt } from './prompt';
import { decrypt } from '../core/crypto';
import { env } from '../core/env';
import { log } from '../core/logger';
import crypto from 'crypto';

const MAX_TOOL_ROUNDS = 6;
const HISTORY_LIMIT = 16;

export interface AskInput {
    tenant: Tenant;
    actorTgId: string;
    actorName: string;
    role: Role;
    text?: string;
    audio?: { buffer: Buffer; mimeType: string };
}

export interface AskResult {
    reply: string;
    transcript?: string;
    toolsUsed: string[];
}

function tenantKey(tenant: Tenant): string | undefined {
    if (!tenant.geminiKeyEnc) return undefined;
    try {
        return decrypt(tenant.geminiKeyEnc);
    } catch {
        return undefined;
    }
}

function chatKey(tenantId: string, actorTgId: string): string {
    return `${tenantId}:${actorTgId}`;
}

async function loadHistory(tenantId: string, actorTgId: string): Promise<Content[]> {
    const rows = await prisma.aiMessage.findMany({
        where: { chatKey: chatKey(tenantId, actorTgId) },
        orderBy: { createdAt: 'desc' },
        take: HISTORY_LIMIT,
    });
    return rows
        .reverse()
        .map(r => ({ role: r.role === 'model' ? 'model' : 'user', parts: [{ text: r.content }] } as Content));
}

async function saveTurn(tenantId: string, actorTgId: string, userText: string, modelText: string): Promise<void> {
    const key = chatKey(tenantId, actorTgId);
    await prisma.aiMessage.createMany({
        data: [
            { tenantId, chatKey: key, role: 'user', content: userText.slice(0, 4000) },
            { tenantId, chatKey: key, role: 'model', content: modelText.slice(0, 4000) },
        ],
    });
    // Eski yozuvlarni tozalab turamiz — kontekst va joy tejaladi
    const old = await prisma.aiMessage.findMany({
        where: { chatKey: key },
        orderBy: { createdAt: 'desc' },
        skip: HISTORY_LIMIT * 2,
        select: { id: true },
    });
    if (old.length) {
        await prisma.aiMessage.deleteMany({ where: { id: { in: old.map(o => o.id) } } });
    }
}

export async function clearHistory(tenantId: string, actorTgId: string): Promise<number> {
    const res = await prisma.aiMessage.deleteMany({ where: { chatKey: chatKey(tenantId, actorTgId) } });
    return res.count;
}

export function aiAvailable(tenant: Tenant): boolean {
    return hasGemini(tenantKey(tenant) ?? env.GEMINI_API_KEY);
}

/// AI agentga savol berish. Ovozli xabar bo'lsa avval matnga aylantiriladi,
/// keyin function-calling sikli ishga tushadi.
export async function ask(input: AskInput): Promise<AskResult> {
    const { tenant, actorTgId, actorName, role } = input;
    const apiKey = tenantKey(tenant) ?? env.GEMINI_API_KEY;
    if (!apiKey) {
        return { reply: "🤖 AI hali sozlanmagan. Super admin GEMINI_API_KEY ni qo'shishi kerak.", toolsUsed: [] };
    }

    let userText = (input.text ?? '').trim();
    let transcript: string | undefined;

    if (input.audio) {
        try {
            transcript = await transcribeAudio(input.audio.buffer, input.audio.mimeType, apiKey);
            userText = [userText, transcript].filter(Boolean).join('\n');
        } catch (e) {
            log.error('agent', 'ovozni tanishda xato', e);
            return { reply: '🎙 Ovozli xabarni tushunolmadim. Iltimos, matn bilan yozing.', toolsUsed: [] };
        }
    }

    if (!userText) return { reply: 'Savolingizni yozing yoki ovozli xabar yuboring.', toolsUsed: [] };

    const ctx: ToolContext = {
        tenant,
        actorTgId,
        role,
        batchId: crypto.randomUUID(),
    };

    const history = await loadHistory(tenant.id, actorTgId);
    const contents: Content[] = [...history, { role: 'user', parts: [{ text: userText }] }];
    const tools = declarationsFor(role);
    const system = systemPrompt(tenant, role, actorName);
    const toolsUsed: string[] = [];

    try {
        for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
            const res = await generate(contents, { apiKey, system, tools, temperature: 0.5 });

            if (res.functionCalls.length === 0) {
                const reply = res.text || "Tushunmadim, boshqacha aytib ko'rasizmi?";
                await saveTurn(tenant.id, actorTgId, userText, reply);
                return { reply, transcript, toolsUsed };
            }

            // Model chaqirgan funksiyalarni bajaramiz va natijani qaytaramiz
            contents.push({
                role: 'model',
                parts: res.functionCalls.map(fc => ({ functionCall: { name: fc.name, args: fc.args } })),
            });

            const responses = [];
            for (const call of res.functionCalls) {
                toolsUsed.push(call.name);
                log.info('agent', `tool: ${call.name} (${role}, tenant=${tenant.id})`);
                const out = await runTool(call.name, call.args, ctx);
                responses.push({
                    functionResponse: {
                        name: call.name,
                        response: (out && typeof out === 'object' ? out : { result: out }) as Record<string, unknown>,
                    },
                });
            }
            contents.push({ role: 'user', parts: responses });
        }

        const fallback = "Juda ko'p qadam bo'ldi — so'rovni soddalashtirib qayta yuboring.";
        await saveTurn(tenant.id, actorTgId, userText, fallback);
        return { reply: fallback, transcript, toolsUsed };
    } catch (e) {
        log.error('agent', 'AI xatosi', e);
        const msg = e instanceof GeminiError ? e.message : 'AI bilan bog\'lanishda xato yuz berdi.';
        return { reply: `⚠️ ${msg}`, transcript, toolsUsed };
    }
}
