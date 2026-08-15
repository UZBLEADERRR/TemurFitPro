import { useEffect, useMemo, useState } from 'react';
import { api, MEALS, type Board, type Me, type Streak } from '../lib/api';
import { Avatar, Card, MealDots, Empty, Loading } from './bits';
import { haptic } from '../lib/telegram';

function shiftDate(date: string, delta: number): string {
    const d = new Date(`${date}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + delta);
    return d.toISOString().slice(0, 10);
}

function humanDate(date: string, today: string): string {
    if (date === today) return 'Bugun';
    if (date === shiftDate(today, -1)) return 'Kecha';
    const d = new Date(`${date}T12:00:00Z`);
    return d.toLocaleDateString('uz-UZ', { day: 'numeric', month: 'long' });
}

export default function Today({ me, onPick }: { me: Me; onPick: (id: string) => void }) {
    const today = useMemo(() => new Date().toLocaleDateString('en-CA', { timeZone: me.tenant.timezone }), [me]);
    const [date, setDate] = useState(today);
    const [board, setBoard] = useState<Board | null>(null);
    const [streak, setStreak] = useState<Streak | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let live = true;
        setLoading(true);
        api.board(date)
            .then(b => live && setBoard(b))
            .catch(() => live && setBoard(null))
            .finally(() => live && setLoading(false));
        return () => {
            live = false;
        };
    }, [date]);

    useEffect(() => {
        if (!me.member) return;
        api.streak().then(setStreak).catch(() => undefined);
    }, [me]);

    const summary = useMemo(() => {
        if (!board) return null;
        let done = 0;
        let late = 0;
        let missing = 0;
        for (const m of board.members) {
            for (const meal of MEALS) {
                const s = m.meals[meal.key];
                if (s === 'on_time') done++;
                else if (s === 'late') late++;
                else missing++;
            }
        }
        return { done, late, missing, total: done + late + missing };
    }, [board]);

    const move = (d: number) => {
        haptic();
        const next = shiftDate(date, d);
        if (next > today) return;
        setDate(next);
    };

    return (
        <div className="screen">
            <div className="head">
                <div>
                    <h1>{humanDate(date, today)}</h1>
                    <p className="sub">{date}</p>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                    <button className="pill" onClick={() => move(-1)} aria-label="Oldingi kun">
                        ‹
                    </button>
                    <button className="pill" onClick={() => move(1)} disabled={date >= today} aria-label="Keyingi kun">
                        ›
                    </button>
                </div>
            </div>

            {streak !== null && me.role === 'member' && (
                <Card title="Mening seriyam">
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 12 }}>
                        <span style={{ fontSize: 34, fontWeight: 700, letterSpacing: '-1px' }}>{streak.streak}</span>
                        <span style={{ color: 'var(--hint)', fontSize: 13 }}>
                            kun ketma-ket to'liq bajarildi 🔥
                        </span>
                    </div>
                    <div className="grid30">
                        {streak.days.map(d => (
                            <div
                                key={d.date}
                                className={`cell l${Math.min(3, d.done)}${d.date === today ? ' today' : ''}`}
                                title={`${d.date}: ${d.done}/3`}
                            />
                        ))}
                    </div>
                </Card>
            )}

            {summary && summary.total > 0 && (
                <div className="stat-grid">
                    <div className="stat">
                        <span className="v" style={{ color: 'var(--ok)' }}>
                            {summary.done}
                        </span>
                        <div className="k">Vaqtida</div>
                    </div>
                    <div className="stat">
                        <span className="v" style={{ color: 'var(--late)' }}>
                            {summary.late}
                        </span>
                        <div className="k">Kech</div>
                    </div>
                    <div className="stat">
                        <span className="v" style={{ color: 'var(--hint)' }}>
                            {summary.missing}
                        </span>
                        <div className="k">Yo'q</div>
                    </div>
                </div>
            )}

            {loading ? (
                <Loading />
            ) : !board || board.members.length === 0 ? (
                <Empty icon="🍽" text="Bu kunda ma'lumot yo'q" />
            ) : (
                <Card tight>
                    {board.members.map(m => (
                        <button key={m.id} className="row" onClick={() => { haptic(); onPick(m.id); }}>
                            <Avatar name={m.name} />
                            <div className="grow">
                                <div className="name">{m.name}</div>
                                {m.groups.length > 0 && <div className="meta">{m.groups.map(g => g.title).join(' · ')}</div>}
                            </div>
                            <MealDots meals={m.meals} />
                        </button>
                    ))}
                </Card>
            )}
        </div>
    );
}
