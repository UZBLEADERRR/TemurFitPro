import { useEffect, useState } from 'react';
import { api, MEALS, type MealKey, type MemberDetail } from '../lib/api';
import { Avatar, Loading, Switch } from './bits';
import { openProfile, haptic } from '../lib/telegram';

const MARK: Record<string, { cls: string; ch: string }> = {
    on_time: { cls: 'on_time', ch: '✓' },
    late: { cls: 'late', ch: '!' },
    missing: { cls: 'missing', ch: '·' },
};

export default function MemberSheet({
    id,
    canEdit,
    onClose,
}: {
    id: string;
    /// Murabbiy eslatmalarni o'chirib/yoqib qo'ya oladi
    canEdit: boolean;
    onClose: () => void;
}) {
    const [data, setData] = useState<MemberDetail | null>(null);
    const [error, setError] = useState('');
    const [saving, setSaving] = useState<MealKey | null>(null);

    /// Eslatmani yoqish/o'chirish. Ekranni darrov yangilaymiz, xato bo'lsa qaytaramiz.
    const toggleReminder = async (meal: MealKey, on: boolean) => {
        if (!data || saving) return;
        setSaving(meal);
        const prev = data.reminders;
        setData({ ...data, reminders: { ...prev, [meal]: on } });
        try {
            await api.setReminder(id, meal, !on);
            haptic('success');
        } catch (e) {
            setData(d => (d ? { ...d, reminders: prev } : d));
            setError(e instanceof Error ? e.message : 'Saqlanmadi');
            haptic('error');
        } finally {
            setSaving(null);
        }
    };

    useEffect(() => {
        let live = true;
        api.member(id, 14)
            .then(d => live && setData(d))
            .catch(e => live && setError(e.message));
        return () => {
            live = false;
        };
    }, [id]);

    // Ochilganda orqa fon aylanmasin
    useEffect(() => {
        document.body.style.overflow = 'hidden';
        return () => {
            document.body.style.overflow = '';
        };
    }, []);

    const pct = data ? Math.round((data.total / data.expected) * 100) : 0;

    return (
        <>
            <div className="sheet-bg" onClick={onClose} />
            <div className="sheet" role="dialog" aria-modal="true">
                <div className="handle" />
                {error && <div className="err">{error}</div>}
                {!data && !error && <Loading rows={3} />}
                {data && (
                    <>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
                            <Avatar name={data.member.name} />
                            <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ fontSize: 18, fontWeight: 600 }}>{data.member.name}</div>
                                <div style={{ fontSize: 12, color: 'var(--hint)' }}>{data.member.timezone}</div>
                            </div>
                            <span className={`pill ${pct >= 80 ? 'ok' : 'warn'}`}>{pct}%</span>
                        </div>

                        <p className="card-title">Oxirgi 14 kun</p>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                            {[...data.days].reverse().map(d => (
                                <div key={d.date} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                    <span
                                        style={{
                                            fontSize: 12,
                                            color: 'var(--hint)',
                                            width: 52,
                                            fontVariantNumeric: 'tabular-nums',
                                        }}
                                    >
                                        {d.date.slice(5)}
                                    </span>
                                    <div className="dots">
                                        {MEALS.map(meal => {
                                            const found = d.meals.find(m => m.meal === meal.key);
                                            const mark = MARK[found?.status ?? 'missing'];
                                            return (
                                                <span
                                                    key={meal.key}
                                                    className={`dot ${mark.cls}`}
                                                    title={`${meal.label}${found?.at ? ` — ${found.at}` : ''}`}
                                                >
                                                    {mark.ch}
                                                </span>
                                            );
                                        })}
                                    </div>
                                    <span style={{ fontSize: 11, color: 'var(--hint)', marginLeft: 'auto' }}>
                                        {d.meals.filter(m => m.status !== 'missing').length}/3
                                    </span>
                                </div>
                            ))}
                        </div>

                        {canEdit && (
                            <>
                                <p className="card-title" style={{ marginTop: 18 }}>
                                    Eslatmalar
                                </p>
                                <p style={{ fontSize: 12, color: 'var(--hint)', margin: '0 0 8px' }}>
                                    O'chirilgan ovqat uchun guruhda eslatma yozilmaydi
                                </p>
                                {MEALS.map(m => (
                                    <div key={m.key} className="field">
                                        <label>{m.label}</label>
                                        <Switch
                                            on={data.reminders[m.key]}
                                            onChange={v => toggleReminder(m.key, v)}
                                        />
                                    </div>
                                ))}
                            </>
                        )}

                        {(data.member.username || data.member.telegramId) && (
                            <button
                                className="btn"
                                style={{ marginTop: 18 }}
                                onClick={() => openProfile(data.member)}
                            >
                                💬 Telegramda ochish
                            </button>
                        )}

                        <button className="btn ghost" style={{ marginTop: 8 }} onClick={onClose}>
                            Yopish
                        </button>
                    </>
                )}
            </div>
        </>
    );
}
