// Ma'lumotlar papkasi QAYERDA — bitta joyda hal qilinadi.
//
// Buni prestart.js ham, ilovaning o'zi ham shu yerdan oladi. Ilgari ikkalasi
// alohida hisoblardi va bir-biriga mos kelmasdi: prestart "/data" ga,
// ilova esa "<cwd>/data" ga qarardi.
//
// Eng muhimi — Railway'da Volume ulanmagan bo'lsa ISHGA TUSHMAYMIZ.
// Ilgari bunday holatda bot konteyner ichidagi papkaga yozardi, u esa
// har deployda yangidan yaratiladi: butun ma'lumot jimgina yo'qolardi.
// Yiqilib, sababini aytgan ancha yaxshi.

const path = require('path');

function onRailway() {
    return !!(
        process.env.RAILWAY_ENVIRONMENT_NAME ||
        process.env.RAILWAY_ENVIRONMENT ||
        process.env.RAILWAY_PROJECT_ID ||
        process.env.RAILWAY_SERVICE_ID
    );
}

function resolveDataDir() {
    const explicit = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH;
    if (explicit) return explicit;

    if (onRailway()) {
        throw new Error(
            [
                "Volume ulanmagan — ma'lumotlar saqlanadigan joy yo'q.",
                '',
                'Railway → Service → Settings → Volumes → Add Volume,',
                'mount path: /data',
                '',
                "Busiz bot konteyner ichiga yozadi va butun ma'lumot har",
                'deployda yo‘qoladi. Shuning uchun ishga tushirmayapman.',
                '',
                "Boshqa joyga yozmoqchi bo'lsangiz DATA_DIR ni o'zingiz qo'ying.",
            ].join('\n'),
        );
    }

    // Lokal ishlab chiqish
    return path.resolve(process.cwd(), 'data');
}

module.exports = { resolveDataDir, onRailway };
