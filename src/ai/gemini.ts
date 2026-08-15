import { env } from '../core/env';
import { log } from '../core/logger';

// Gemini 3 Flash Preview — generativelanguage REST API.
// SDK o'rniga to'g'ridan-to'g'ri REST: bog'liqlik kam, versiya o'zgarishlariga chidamli.

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

export interface FunctionDeclaration {
    name: string;
    description: string;
    parameters: {
        type: 'object';
        properties: Record<string, unknown>;
        required?: string[];
    };
}

export type Part =
    | { text: string }
    | { inlineData: { mimeType: string; data: string } }
    | { functionCall: { name: string; args: Record<string, unknown> } }
    | { functionResponse: { name: string; response: Record<string, unknown> } };

export interface Content {
    role: 'user' | 'model';
    parts: Part[];
}

export interface GenerateOptions {
    apiKey?: string;
    model?: string;
    system?: string;
    tools?: FunctionDeclaration[];
    temperature?: number;
    maxOutputTokens?: number;
}

export interface GenerateResult {
    text: string;
    functionCalls: Array<{ name: string; args: Record<string, unknown> }>;
    raw: any;
}

export class GeminiError extends Error {}

export function hasGemini(tenantKey?: string | null): boolean {
    return !!(tenantKey || env.GEMINI_API_KEY);
}

export async function generate(contents: Content[], opts: GenerateOptions = {}): Promise<GenerateResult> {
    const apiKey = opts.apiKey || env.GEMINI_API_KEY;
    if (!apiKey) throw new GeminiError('GEMINI_API_KEY sozlanmagan');

    const model = opts.model || env.GEMINI_MODEL;
    const body: Record<string, unknown> = {
        contents,
        generationConfig: {
            temperature: opts.temperature ?? 0.6,
            maxOutputTokens: opts.maxOutputTokens ?? 2048,
            ...(process.env.GEMINI_THINKING_LEVEL
                ? { thinkingConfig: { thinkingLevel: process.env.GEMINI_THINKING_LEVEL } }
                : {}),
        },
    };
    if (opts.system) body.systemInstruction = { parts: [{ text: opts.system }] };
    if (opts.tools?.length) body.tools = [{ functionDeclarations: opts.tools }];

    const res = await fetch(`${BASE}/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(body),
    });

    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        log.error('gemini', `HTTP ${res.status}`, detail.slice(0, 500));
        throw new GeminiError(`Gemini xatosi (${res.status}): ${extractApiMessage(detail)}`);
    }

    const json: any = await res.json();
    const candidate = json?.candidates?.[0];
    const parts: any[] = candidate?.content?.parts ?? [];

    const text = parts
        .filter(p => typeof p.text === 'string')
        .map(p => p.text)
        .join('')
        .trim();

    const functionCalls = parts
        .filter(p => p.functionCall)
        .map(p => ({ name: p.functionCall.name, args: (p.functionCall.args ?? {}) as Record<string, unknown> }));

    if (!text && functionCalls.length === 0 && candidate?.finishReason === 'SAFETY') {
        throw new GeminiError('Javob xavfsizlik filtri tomonidan bloklandi.');
    }

    return { text, functionCalls, raw: json };
}

/// Ovozli xabarni matnga aylantirish (Gemini audioni to'g'ridan-to'g'ri tushunadi).
export async function transcribeAudio(
    audio: Buffer,
    mimeType = 'audio/ogg',
    apiKey?: string,
): Promise<string> {
    const res = await generate(
        [
            {
                role: 'user',
                parts: [
                    {
                        text:
                            "Bu ovozli xabarni SO'ZMA-SO'Z matnga aylantir. Faqat matnning o'zini qaytar, " +
                            "hech qanday izoh, tirnoq yoki qo'shimcha so'z yozma. Til o'zbekcha yoki ruscha bo'lishi mumkin — " +
                            'qaysi tilda aytilgan bo\'lsa, o\'sha tilda yoz.',
                    },
                    { inlineData: { mimeType, data: audio.toString('base64') } },
                ],
            },
        ],
        { apiKey, temperature: 0.1, maxOutputTokens: 1024 },
    );
    return res.text;
}

function extractApiMessage(raw: string): string {
    try {
        const j = JSON.parse(raw);
        return j?.error?.message || raw.slice(0, 200);
    } catch {
        return raw.slice(0, 200);
    }
}
