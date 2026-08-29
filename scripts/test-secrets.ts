/// Kalitlarning o'zi yaratilishi va SAQLANIB QOLISHI testi.
///
/// Eng muhim savol: deploy qilinganda shifrlash kaliti o'zgarib ketmaydimi?
/// O'zgarsa — saqlangan bot tokenlari ochilmay qoladi. Shuni tekshiramiz:
/// bir jarayonda shifrlab, IKKINCHI jarayonda (ya'ni "restartdan keyin") ochamiz.

import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const ok: string[] = [];
function pass(name: string) {
    ok.push(name);
    console.log(`✅ ${name}`);
}
function fail(name: string, detail: string): never {
    console.error(`❌ ${name}\n   ${detail}`);
    process.exit(1);
}

/// Alohida jarayonda kod ishga tushirish — modul keshi tozalanadi,
/// ya'ni haqiqiy restart bilan bir xil.
function inFreshProcess(dataDir: string, code: string, extraEnv: Record<string, string> = {}): string {
    const env = { ...process.env, DATA_DIR: dataDir, ...extraEnv };
    delete (env as Record<string, string | undefined>).RAILWAY_VOLUME_MOUNT_PATH;
    if (!('ENCRYPTION_KEY' in extraEnv)) delete (env as Record<string, string | undefined>).ENCRYPTION_KEY;
    if (!('CONTROL_WEBHOOK_SECRET' in extraEnv)) {
        delete (env as Record<string, string | undefined>).CONTROL_WEBHOOK_SECRET;
    }

    const out = execFileSync('npx', ['tsx', '-e', code], {
        env,
        encoding: 'utf8',
        cwd: path.join(__dirname, '..'),
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    // dotenv o'z maslahatlarini stdout'ga yozadi — bizga faqat oxirgi qator kerak
    const lines = out.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('◇'));
    return lines[lines.length - 1] ?? '';
}

const SECRETS = "const s = require('./src/core/secrets');";
const CRYPTO = "const c = require('./src/core/crypto');";

// ---------------------------------------------------------------- 1
{
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tfp-'));
    const key1 = inFreshProcess(dir, `${SECRETS} console.log(s.encryptionKey());`);

    if (!key1 || key1.length < 40) fail('1 kalit yaratildi', `kalit juda kalta: ${key1}`);
    if (!fs.existsSync(path.join(dir, 'secrets.json'))) fail('1 kalit yaratildi', 'secrets.json yozilmadi');
    pass('1  env bo\'sh bo\'lsa kalit o\'zi yaratiladi va faylga yoziladi');

    // ---------------------------------------------------------------- 2
    const key2 = inFreshProcess(dir, `${SECRETS} console.log(s.encryptionKey());`);
    if (key1 !== key2) fail('2 kalit saqlanadi', `restartdan keyin o'zgarib ketdi:\n  ${key1}\n  ${key2}`);
    pass('2  restartdan keyin AYNAN o\'sha kalit qaytadi');

    // ---------------------------------------------------------------- 3
    // Haqiqiy stsenariy: bot tokeni bugun shifrlanadi, ertaga deploydan keyin ochiladi
    const token = '7891234567:AAHdqTcvbXXXXXXXXXXXXXXXXXXXXXXXXXX';
    const enc = inFreshProcess(dir, `${CRYPTO} console.log(c.encrypt(${JSON.stringify(token)}));`);
    const dec = inFreshProcess(dir, `${CRYPTO} console.log(c.decrypt(${JSON.stringify(enc)}));`);
    if (dec !== token) fail('3 token ochiladi', `kutilgan ${token}, kelgan ${dec}`);
    pass('3  bir jarayonda shifrlangan token boshqasida ochiladi');

    // ---------------------------------------------------------------- 4
    const hookSecret = inFreshProcess(dir, `${SECRETS} console.log(s.controlWebhookSecret());`);
    const hookSecret2 = inFreshProcess(dir, `${SECRETS} console.log(s.controlWebhookSecret());`);
    if (hookSecret === 'control') fail('4 webhook siri', "eski 'control' qiymati qolib ketdi");
    if (hookSecret !== hookSecret2) fail('4 webhook siri', 'restartda o\'zgardi');
    pass('4  webhook siri ham o\'zi yaratiladi va saqlanadi');

    fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------- 5
// Eski o'rnatmadan ko'chish: env'dagi kalit faylga OLINADI, keyin env'siz ham ishlaydi
{
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tfp-'));
    const envKey = 'eski-railwaydagi-kalit-0123456789abcdef';

    const adopted = inFreshProcess(dir, `${SECRETS} console.log(s.encryptionKey());`, { ENCRYPTION_KEY: envKey });
    if (adopted !== envKey) fail('5 env ko\'chirish', `env kaliti olinmadi: ${adopted}`);

    const token = 'eski-token-qiymati';
    const enc = inFreshProcess(dir, `${CRYPTO} console.log(c.encrypt(${JSON.stringify(token)}));`, {
        ENCRYPTION_KEY: envKey,
    });

    // Endi Railway'dan ENCRYPTION_KEY olib tashlandi — baribir ochilishi kerak
    const dec = inFreshProcess(dir, `${CRYPTO} console.log(c.decrypt(${JSON.stringify(enc)}));`);
    if (dec !== token) fail('5 env ko\'chirish', `env olib tashlangach ochilmadi: ${dec}`);
    pass('5  env\'dagi eski kalit faylga ko\'chadi — env\'ni o\'chirsa ham tokenlar ochiladi');

    fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------- 6
// Volume ulanmagan holat: har safar yangi papka → kalit yangi → ogohlantirish kerak
{
    const a = fs.mkdtempSync(path.join(os.tmpdir(), 'tfp-'));
    const b = fs.mkdtempSync(path.join(os.tmpdir(), 'tfp-'));
    const isNewA = inFreshProcess(a, `${SECRETS} s.encryptionKey(); console.log(s.encryptionKeyIsNew());`);
    const isNewB = inFreshProcess(a, `${SECRETS} s.encryptionKey(); console.log(s.encryptionKeyIsNew());`);
    const isNewC = inFreshProcess(b, `${SECRETS} s.encryptionKey(); console.log(s.encryptionKeyIsNew());`);

    if (isNewA !== 'true') fail('6 yangi kalit belgisi', `birinchi ishga tushishda false: ${isNewA}`);
    if (isNewB !== 'false') fail('6 yangi kalit belgisi', `ikkinchi ishga tushishda true: ${isNewB}`);
    if (isNewC !== 'true') fail('6 yangi kalit belgisi', `bo'sh papkada false: ${isNewC}`);
    pass('6  Volume yo\'qolsa "kalit yangi" belgisi yonadi (index.ts ogohlantiradi)');

    fs.rmSync(a, { recursive: true, force: true });
    fs.rmSync(b, { recursive: true, force: true });
}

// ---------------------------------------------------------------- 7
// Bot ichidan qo'yilgan Gemini kaliti env'dagidan ustun turadi
{
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tfp-'));
    fs.mkdirSync(path.join(dir, 'tenants'), { recursive: true });

    execFileSync('npx', ['prisma', 'db', 'push', '--schema', 'prisma/platform.prisma', '--skip-generate', '--accept-data-loss'], {
        env: { ...process.env, PLATFORM_DATABASE_URL: `file:${path.join(dir, 'platform.db')}` },
        cwd: path.join(__dirname, '..'),
        stdio: 'ignore',
    });

    const script = `
        (async () => {
            const st = require('./src/core/settings');
            await st.loadSettings();
            if (st.settings().geminiApiKey !== 'env-kaliti') throw new Error('env kaliti olinmadi');
            await st.setGeminiKey('bot-ichidan-qoyilgan-kalit');
            if (st.settings().geminiApiKey !== 'bot-ichidan-qoyilgan-kalit') throw new Error('bot kaliti saqlanmadi');
            if (!st.settings().geminiKeyFromBot) throw new Error('manba belgilanmadi');
            await st.setGeminiModel('gemini-3-pro-preview');
            await st.setAiEnabled(false);
            await st.setPublicUrl('https://misol.up.railway.app/');
            console.log('YOZILDI');
            process.exit(0);
        })();
    `;
    const w = inFreshProcess(dir, script, { GEMINI_API_KEY: 'env-kaliti', CONTROL_BOT_TOKEN: '1:test' });
    if (!w.includes('YOZILDI')) fail('7 sozlamalar', w);

    // Restartdan keyin ham o'sha qiymatlar (shifrlangan kalit ochilishi bilan)
    const verify = `
        (async () => {
            const st = require('./src/core/settings');
            await st.loadSettings();
            const s = st.settings();
            console.log(JSON.stringify({
                key: s.geminiApiKey, fromBot: s.geminiKeyFromBot,
                model: s.geminiModel, ai: s.aiEnabled, url: s.publicUrl,
                app: st.webappUrl('t1'),
            }));
            process.exit(0);
        })();
    `;
    const out = inFreshProcess(dir, verify, { GEMINI_API_KEY: 'env-kaliti', CONTROL_BOT_TOKEN: '1:test' });
    const got = JSON.parse(out);

    if (got.key !== 'bot-ichidan-qoyilgan-kalit') fail('7 sozlamalar', `kalit: ${got.key}`);
    if (got.fromBot !== true) fail('7 sozlamalar', 'manba noto\'g\'ri');
    if (got.model !== 'gemini-3-pro-preview') fail('7 sozlamalar', `model: ${got.model}`);
    if (got.ai !== false) fail('7 sozlamalar', 'AI o\'chirilmadi');
    if (got.url !== 'https://misol.up.railway.app') fail('7 sozlamalar', `url: ${got.url}`);
    if (got.app !== 'https://misol.up.railway.app/app?t=t1') fail('7 sozlamalar', `webappUrl: ${got.app}`);
    pass('7  bot ichidan qo\'yilgan Gemini kaliti/model/URL restartdan keyin ham turadi');

    // Bot ichidagi kalit olib tashlansa — env'dagisiga qaytadi
    const clear = `
        (async () => {
            const st = require('./src/core/settings');
            await st.loadSettings();
            await st.clearGeminiKey();
            const s = st.settings();
            console.log(JSON.stringify({ key: s.geminiApiKey, fromBot: s.geminiKeyFromBot }));
            process.exit(0);
        })();
    `;
    const cleared = JSON.parse(
        inFreshProcess(dir, clear, { GEMINI_API_KEY: 'env-kaliti', CONTROL_BOT_TOKEN: '1:test' }),
    );
    if (cleared.key !== 'env-kaliti' || cleared.fromBot !== false) {
        fail('7 sozlamalar', `env'ga qaytmadi: ${JSON.stringify(cleared)}`);
    }
    pass('8  bot ichidagi kalit o\'chirilsa Railway env\'dagisiga qaytadi');

    fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\nHAMMASI O'TDI (${ok.length})`);
