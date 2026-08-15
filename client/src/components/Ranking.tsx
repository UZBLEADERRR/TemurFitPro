import { useEffect, useState } from 'react';
import { api, type Stats, type InactiveRow } from '../lib/api';
import { Avatar, Card, Segmented, Empty, Loading, rateClass } from './bits';
import { haptic } from '../lib/telegram';

type Tab = 'reyting' | 'yubormaganlar';

export default function Ranking({ onPick }: { onPick: (id: string) => void }) {
    const [tab, setTab] = useState<Tab>('reyting');
    const [days, setDays] = useState(7);
    const [gapDays, setGapDays] = useState(2);
    const [stats, setStats] = useState<Stats | null>(null);
    const [inactive, setInactive] = useState<InactiveRow[] | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');

    useEffect(() => {
        let live = true;
        setLoading(true);
        setError('');
        const req = tab === 'reyting' ? api.stats(days) : api.inactive(gapDays);
        req
            .then(res => {
                if (!live) return;
                if (tab === 'reyting') setStats(res as Stats);
                else setInactive(res as InactiveRow[]);
            })
            .catch(e => live && setError(e.message))
            .finally(() => live && setLoading(false));
        return () => {
            live = false;
        };
    }, [tab, days, gapDays]);

    return (
        <div className="screen">
            <div className="head">
                <div>
                    <h1>Reyting</h1>
                    <p className="sub">Intizom va e'tibor talab qiluvchilar</p>
                </div>
            </div>

            <Segmented
                value={tab}
                onChange={v => { haptic(); setTab(v); }}
                options={[
                    { value: 'reyting', label: 'Intizom' },
                    { value: 'yubormaganlar', label: 'Yubormaganlar' },
                ]}
            />

            {error && <div className="err">{error}</div>}

            {tab === 'reyting' ? (
                <>
                    <Segmented
                        value={days}
                        onChange={v => { haptic(); setDays(v); }}
                        options={[
                            { value: 7, label: '7 kun' },
                            { value: 14, label: '14 kun' },
                            { value: 30, label: '30 kun' },
                        ]}
                    />
                    {loading ? (
                        <Loading />
                    ) : !stats || stats.rows.length === 0 ? (
                        <Empty icon="📊" text="Ma'lumot yig'ilmagan" />
                    ) : (
                        <Card tight>
                            {stats.rows.map((r, i) => (
                                <button key={r.id} className="row" onClick={() => { haptic(); onPick(r.id); }}>
                                    <span style={{ width: 18, color: 'var(--hint)', fontSize: 13, fontWeight: 600 }}>
                                        {i + 1}
                                    </span>
                                    <Avatar name={r.name} />
                                    <div className="grow">
                                        <div className="name">{r.name}</div>
                                        <div className={`bar ${rateClass(r.rate)}`}>
                                            <i style={{ width: `${r.rate}%` }} />
                                        </div>
                                    </div>
                                    <span style={{ fontWeight: 700, fontSize: 14, fontVariantNumeric: 'tabular-nums' }}>
                                        {r.rate}%
                                    </span>
                                </button>
                            ))}
                        </Card>
                    )}
                </>
            ) : (
                <>
                    <Segmented
                        value={gapDays}
                        onChange={v => { haptic(); setGapDays(v); }}
                        options={[
                            { value: 1, label: '1 kun' },
                            { value: 2, label: '2 kun' },
                            { value: 3, label: '3 kun' },
                            { value: 7, label: '7 kun' },
                        ]}
                    />
                    {loading ? (
                        <Loading />
                    ) : !inactive || inactive.length === 0 ? (
                        <Empty icon="✅" text={`Oxirgi ${gapDays} kunda hamma yuborgan`} />
                    ) : (
                        <Card tight>
                            {inactive.map(r => (
                                <button key={r.id} className="row" onClick={() => { haptic(); onPick(r.id); }}>
                                    <Avatar name={r.name} />
                                    <div className="grow">
                                        <div className="name">{r.name}</div>
                                        <div className="meta">
                                            {r.lastMealDate ? `Oxirgi: ${r.lastMealDate}` : 'Hech qachon yubormagan'}
                                        </div>
                                    </div>
                                    <span className="pill warn">
                                        {r.daysSince === null ? '—' : `${r.daysSince} kun`}
                                    </span>
                                </button>
                            ))}
                        </Card>
                    )}
                </>
            )}
        </div>
    );
}
