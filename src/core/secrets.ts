import crypto from 'crypto';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { DATA_DIR, ensureDirs } from './paths';

// env.ts dan oldin yuklanishi mumkin — lokalda .env o'qilmay qolmasin.
dotenv.config();

// Railway'da qo'lda kalit yozib o'tirmaslik uchun: shifrlash kaliti va webhook
// siri BIR MARTA o'zi yaratiladi va Volume ichidagi faylda qoladi. Deploy
// qilinganda ham o'zgarmaydi — chunki fayl Volume'da, konteynerda emas.
//
//   <DATA_DIR>/secrets.json   { encryptionKey, controlWebhookSecret }
//
// Env'da kalit turgan bo'lsa — o'sha olinadi va faylga KO'CHIRILADI. Shu sabab
// eski o'rnatmadan yangisiga o'tish xavfsiz: bir marta ishga tushgach env
// o'zgaruvchisini olib tashlash mumkin, tokenlar baribir ochiladi.

const FILE = path.join(DATA_DIR, 'secrets.json');

interface Secrets {
    encryptionKey: string;
    controlWebhookSecret: string;
}

/// Fayl birinchi marta yaratildimi. Volume ulanmagan bo'lsa bu HAR deployda
/// true bo'ladi — index.ts shuni sezib ogohlantiradi.
let created = false;

/// Kalit qayerdan kelgani — 🔑 Kalitlar panelida ko'rsatiladi.
let source: 'fayl' | 'env' | 'yangi' = 'fayl';

let cache: Secrets | null = null;

function readFile(): Partial<Secrets> {
    try {
        const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
        return typeof parsed === 'object' && parsed ? parsed : {};
    } catch {
        return {};
    }
}

function writeFile(s: Secrets): void {
    ensureDirs();
    const tmp = `${FILE}.tmp`;
    // Avval vaqtinchalik faylga, keyin rename — yozish yarmida uzilsa ham
    // secrets.json buzilmaydi.
    fs.writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, FILE);
}

function load(): Secrets {
    if (cache) return cache;

    const onDisk = readFile();
    source = onDisk.encryptionKey ? 'fayl' : process.env.ENCRYPTION_KEY ? 'env' : 'yangi';

    const next: Secrets = {
        encryptionKey:
            onDisk.encryptionKey || process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString('base64'),
        controlWebhookSecret:
            onDisk.controlWebhookSecret ||
            process.env.CONTROL_WEBHOOK_SECRET ||
            crypto.randomBytes(24).toString('base64url'),
    };

    if (!onDisk.encryptionKey || !onDisk.controlWebhookSecret) {
        created = source === 'yangi';
        try {
            writeFile(next);
        } catch (e) {
            // Yozilmasa ham ishlayveramiz, lekin keyingi deployda kalit
            // o'zgaradi — index.ts buni ogohlantirish bilan aytadi.
            console.error(`[secrets] ${FILE} yozilmadi: ${(e as Error).message}`);
        }
    }

    cache = next;
    return next;
}

export function encryptionKey(): string {
    return load().encryptionKey;
}

export function controlWebhookSecret(): string {
    return load().controlWebhookSecret;
}

/// Shifrlash kaliti shu ishga tushishda YANGI yaratildimi.
/// true bo'lsa-yu, bazada botlar bo'lsa — Volume ulanmagan, tokenlar ochilmaydi.
export function encryptionKeyIsNew(): boolean {
    load();
    return created;
}

/// 'fayl' — Volume'dan o'qildi · 'env' — env'dan olinib faylga ko'chirildi
/// 'yangi' — endi yaratildi
export function encryptionKeySource(): 'fayl' | 'env' | 'yangi' {
    load();
    return source;
}

export function secretsFilePath(): string {
    return FILE;
}
