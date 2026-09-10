/// Telegram matn xavfsizligi testi.
///
/// Sababi: production loglarida har kuni yuzlab marta
///   "Bad Request: text must be encoded in UTF-8"
/// chiqardi va bitta guruhning jadvali BUTUNLAY ishlamasdi.
///
/// Sabab: `name.slice(0, 14)` ismdagi emoji surrogat juftligining o'rtasidan
/// kesib, satrda yolg'iz surrogat qoldirardi. Telegram bunday xabarni butunlay
/// rad etadi — shuning uchun bitta a'zoning ismi butun guruhni to'xtatib qo'yardi.

import { safeText, truncate, padVisual, visualLength, esc, chunkText, isChatGone } from '../src/core/telegram';

let passed = 0;
function check(name: string, cond: boolean, detail = ''): void {
    if (!cond) {
        console.error(`❌ ${name}${detail ? `\n   ${detail}` : ''}`);
        process.exit(1);
    }
    passed++;
    console.log(`✅ ${name}`);
}

/// Telegram nimani rad etishini shu tekshiradi: UTF-8 ga o'girib qaytarganda
/// satr o'zgarsa — demak yaroqsiz.
function isValidUtf8(s: string): boolean {
    return Buffer.from(s, 'utf8').toString('utf8') === s;
}

// ---------------------------------------------------------------- 1
{
    // Aynan production'ni buzgan holat: 14-belgi emoji ustiga tushadi
    const name = 'Dilnoza Karim🔥ova';
    const broken = name.slice(0, 14);

    check('1  eski kod haqiqatan yaroqsiz UTF-8 hosil qilardi', !isValidUtf8(broken), JSON.stringify(broken));

    const fixed = truncate(name, 14);
    check('2  truncate() emojini butun qoldiradi', isValidUtf8(fixed), JSON.stringify(fixed));
    check('3  truncate() chegaradan oshmaydi', visualLength(fixed) <= 14, `uzunlik=${visualLength(fixed)}`);
}

// ---------------------------------------------------------------- 2
{
    // Har xil joyda kesilganda ham hech qachon buzilmasin
    const names = [
        'Dilnoza Karim🔥ova',
        '😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀',
        'Jasur 🏋️‍♂️ Toshmatov',
        'Аziz Каримов',
        '田中太郎さんです',
        'Bek',
        '',
    ];
    let allOk = true;
    for (const n of names) {
        for (let w = 1; w <= 20; w++) {
            const t = truncate(n, w);
            if (!isValidUtf8(t) || visualLength(t) > w) {
                allOk = false;
                console.error(`   buzildi: ${JSON.stringify(n)} w=${w} -> ${JSON.stringify(t)}`);
            }
        }
    }
    check('4  har qanday ism, har qanday kenglikda buzilmaydi', allOk);
}

// ---------------------------------------------------------------- 3
{
    // esc() — barcha ismlar shu yerdan o'tadi, oxirgi himoya
    const lone = `Ism${'\uD83D'}chi`; // qo'lda yasalgan yolg'iz surrogat
    check('5  yolg\'iz surrogatli satr haqiqatan yaroqsiz', !isValidUtf8(lone));
    check('6  esc() uni tozalaydi', isValidUtf8(esc(lone)), JSON.stringify(esc(lone)));
    check('7  safeText() uni tozalaydi', isValidUtf8(safeText(lone)));
    check('8  chunkText() uni tozalaydi', chunkText(lone).every(isValidUtf8));

    // Tozalash HTML xavfsizlashni buzmasin
    check('9  esc() HTML belgilarini baribir qochiradi', esc('<b>&</b>') === '&lt;b&gt;&amp;&lt;/b&gt;');
    // Normal emoji saqlanib qolsin — tozalash haddan oshmasin
    check('10 butun emoji o\'chib ketmaydi', safeText('Salom 🔥 Jasur') === 'Salom 🔥 Jasur');
}

// ---------------------------------------------------------------- 4
{
    // Ustun tekislash: emojili ism jadval ustunini buzmasin
    const a = padVisual(truncate('Bek', 10), 10);
    const b = padVisual(truncate('Jasur 🔥', 10), 10);
    check('11 padVisual() emojili va emojisiz ismni bir xil kenglikka keltiradi',
        visualLength(a) === visualLength(b) && visualLength(a) === 10,
        `${visualLength(a)} vs ${visualLength(b)}`);

    // Eski padEnd shu yerda xato qilardi
    const oldA = 'Bek'.padEnd(10);
    const oldB = 'Jasur 🔥'.padEnd(10);
    check('12 eski padEnd() haqiqatan ustunni buzardi',
        Array.from(oldA).length !== Array.from(oldB).length);
}

// ---------------------------------------------------------------- 5
{
    // Loglardagi ikkinchi muammo: "chat not found" har kuni qaytarilardi
    const gone = (d: string) => isChatGone({ response: { description: d } });
    check('13 "chat not found" yetib bo\'lmaydigan chat deb tanildi', gone('Bad Request: chat not found'));
    check('14 "bot was kicked" ham', gone('Forbidden: bot was kicked from the supergroup chat'));
    check('15 vaqtinchalik xato guruhni o\'chirmaydi', !gone('Bad Request: message is not modified'));
    check('16 UTF-8 xatosi guruhni o\'chirmaydi', !gone('Bad Request: text must be encoded in UTF-8'));
}

console.log(`\nHAMMASI O'TDI (${passed})`);
