import type { GroupInfo } from '../lib/api';
import { haptic } from '../lib/telegram';

/// Umumiy / guruh bo'yicha ko'rish. Bitta guruh bo'lsa umuman ko'rsatilmaydi —
/// tanlash uchun narsa yo'q.
export default function GroupFilter({
    groups,
    value,
    onChange,
}: {
    groups: GroupInfo[];
    value: string | null;
    onChange: (v: string | null) => void;
}) {
    if (groups.length < 2) return null;

    const total = groups.reduce((s, g) => s + g.members, 0);

    return (
        <div className="chips">
            <button
                className={value === null ? 'on' : ''}
                onClick={() => {
                    haptic();
                    onChange(null);
                }}
            >
                Hammasi <span className="n">{total}</span>
            </button>
            {groups.map(g => (
                <button
                    key={g.id}
                    className={value === g.id ? 'on' : ''}
                    onClick={() => {
                        haptic();
                        onChange(g.id);
                    }}
                >
                    {g.title} <span className="n">{g.members}</span>
                </button>
            ))}
        </div>
    );
}
