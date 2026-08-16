import crypto from 'crypto';
import type { Tenant } from '../generated/platform';
import { tenantDb } from '../core/db';
import { generate, transcribeAudio, GeminiError, Content } from './gemini';
import { declarationsFor, runTool, ToolContext } from './tools';
import { systemPrompt } from './prompt';
import { decrypt } from '../core/crypto';
import { env } from '../core/env';
import { log } from '../core/logger';
import type { Role } from '../core/roles';

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

function apiKeyFor(tenant: Tenant): string {
    if (tenant.geminiKeyEnc) {
        try {
            return decrypt(tenant.geminiKeyEnc);
        } catch {
            /* buzilgan kalit — global kalitga tushamiz */
        }
    }
    return env.GEMINI_API_KEY;
}

/// AI shu bot uchun ishlaydimi. Kalit bo'lmasa yoki o'chirilgan bo'lsa — yo'q.
export function aiAvailable(tenant: Tenant): boolean {
    return env.AI_ENABLED && !!apiKeyFor(tenant);
}

/// AI nega ishlamayotganini foydalanuvchiga tushuntirish
export function aiOffReason(tenant: Tenant): string {
    if (!env.AI_ENABLED) return "🤖 AI o'chirilgan (AI_ENABLED=false).";
    if (!apiKeyFor(tenant)) return "🤖 AI sozlanmagan — GEMINI_API_KEY qo'shilishi kerak.";
    return '';
}

function chatKey(tenantId: string, actorTgId: string): string {
    return `${tenantId}:${actorTgId}`;
}

async function loadHistory(tenant: Tenant, actorTgId: string): Promise<Content[]> {
    const db = await tenantDb(tenant.botId);
    const rows = await db.aiMessage.findMany({
        where: { chatKey: chatKey(tenant.id, actorTgId) },
        orderBy: { createdAt: 'desc' },
        take: HISTORY_LIMIT,
    });
    return rows
        .reverse()
        .map(r => ({ role: r.role === 'model' ? 'model' : 'user', parts: [{ text: r.content }] }) as Content);
}

async function saveTurn(tenant: Tenant, actorTgId: string, userText: string, modelText: string): Promise<void> {
    const db = await tenantDb(tenant.botId);
    const key = chatKey(tenant.id, actorTgId);
    await db.aiMessage.createMany({
        data: [
            { chatKey: key, role: 'user', content: userText.slice(0, 4000) },
            { chatKey: key, role: 'model', content: modelText.slice(0, 4000) },
        ],
    });

    // Eski yozuvlarni tozalab turamiz — fayl kattalashmasin
    const old = await db.aiMessage.findMany({
        where: { chatKey: key },
        orderBy: { createdAt: 'desc' },
        skip: HISTORY_LIMIT * 2,
        select: { id: true },
    });
    if (old.length) await db.aiMessage.deleteMany({ where: { id: { in: old.map(o => o.id) } } });
}

export async function clearHistory(tenant: Tenant, actorTgId: string): Promise<number> {
    const db = await tenantDb(tenant.botId);
    const res = await db.aiMessage.deleteMany({ where: { chatKey: chatKey(tenant.id, actorTgId) } });
    return res.count;
}

/// AI agentga savol berish.
/// Ovozli xabar bo'lsa avval matnga aylantiriladi, keyin function-calling sikli ishlaydi.
export async function ask(input: AskInput): Promise<AskResult> {
    const { tenant, actorTgId, actorName, role } = input;
    const apiKey = apiKeyFor(tenant);
    if (!env.AI_ENABLED || !apiKey) return { reply: aiOffReason(tenant), toolsUsed: [] };

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
        db: await tenantDb(tenant.botId),
        actorTgId,
        role,
        batchId: crypto.randomUUID(),
    };

    const contents: Content[] = [
        ...(await loadHistory(tenant, actorTgId)),
        { role: 'user', parts: [{ text: userText }] },
    ];
    const tools = declarationsFor(role);
    const system = systemPrompt(tenant, role, actorName);
    const toolsUsed: string[] = [];

    try {
        for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
            const res = await generate(contents, { apiKey, system, tools, temperature: 0.5 });

            if (res.functionCalls.length === 0) {
                const reply = res.text || "Tushunmadim, boshqacha aytib ko'rasizmi?";
                await saveTurn(tenant, actorTgId, userText, reply);
                return { reply, transcript, toolsUsed };
            }

            // Model javobini AYNAN o'zidek qaytaramiz. Gemini 3 functionCall
            // qismlariga thoughtSignature qo'yadi va uni talab qiladi — qayta
            // yig'ilsa "Function call is missing a thought_signature" xatosi chiqadi.
            contents.push(
                res.modelContent ?? {
                    role: 'model',
                    parts: res.functionCalls.map(fc => ({ functionCall: { name: fc.name, args: fc.args } })),
                },
            );

            const responses = [];
            for (const call of res.functionCalls) {
                toolsUsed.push(call.name);
                log.info('agent', `tool: ${call.name} (${role}, ${tenant.botUsername})`);
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
        await saveTurn(tenant, actorTgId, userText, fallback);
        return { reply: fallback, transcript, toolsUsed };
    } catch (e) {
        log.error('agent', 'AI xatosi', e);
        const msg = e instanceof GeminiError ? e.message : "AI bilan bog'lanishda xato yuz berdi.";
        return { reply: `⚠️ ${msg}`, transcript, toolsUsed };
    }
}
