export interface TgUser {
    id: number;
    first_name: string;
    last_name?: string;
    username?: string;
}

interface TgWebApp {
    initData: string;
    initDataUnsafe: { user?: TgUser; start_param?: string };
    colorScheme: 'light' | 'dark';
    themeParams: Record<string, string>;
    ready(): void;
    expand(): void;
    close(): void;
    HapticFeedback?: {
        impactOccurred(style: 'light' | 'medium' | 'heavy'): void;
        notificationOccurred(type: 'error' | 'success' | 'warning'): void;
        selectionChanged(): void;
    };
    setHeaderColor?(color: string): void;
    setBackgroundColor?(color: string): void;
    openTelegramLink?(url: string): void;
}

declare global {
    interface Window {
        Telegram?: { WebApp?: TgWebApp };
    }
}

export const tg = (): TgWebApp | undefined => window.Telegram?.WebApp;

export function initTelegram(): void {
    const app = tg();
    if (!app) return;
    app.ready();
    app.expand();
    document.documentElement.dataset.scheme = app.colorScheme;

    // Telegram mavzu ranglarini CSS o'zgaruvchilariga ko'chiramiz —
    // shunda ilova foydalanuvchining mavzusi bilan bir xil ko'rinadi.
    const p = app.themeParams || {};
    const map: Record<string, string> = {
        '--bg': p.secondary_bg_color || p.bg_color || '',
        '--card': p.bg_color || '',
        '--text': p.text_color || '',
        '--hint': p.hint_color || '',
        '--accent': p.button_color || p.link_color || '',
        '--accent-ink': p.button_text_color || '',
        '--line': p.section_separator_color || '',
    };
    for (const [key, val] of Object.entries(map)) {
        if (val) document.documentElement.style.setProperty(key, val);
    }
}

/// Odamning Telegram profilini ochish.
/// username bo'lsa t.me havolasi ishlatiladi — bu eng ishonchli yo'l.
/// Bo'lmasa tg://user?id= sxemasi (Telegram ichida ishlaydi, brauzerda yo'q).
export function openProfile(user: { telegramId?: string | null; username?: string | null }): void {
    const app = tg();
    haptic();

    if (user.username) {
        const url = `https://t.me/${user.username.replace(/^@/, '')}`;
        if (app?.openTelegramLink) app.openTelegramLink(url);
        else window.open(url, '_blank');
        return;
    }

    if (user.telegramId) {
        window.location.href = `tg://user?id=${user.telegramId}`;
    }
}

export function haptic(kind: 'tap' | 'success' | 'error' = 'tap'): void {
    const h = tg()?.HapticFeedback;
    if (!h) return;
    if (kind === 'tap') h.selectionChanged();
    else h.notificationOccurred(kind === 'success' ? 'success' : 'error');
}
