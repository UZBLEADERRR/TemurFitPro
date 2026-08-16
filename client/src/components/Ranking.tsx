import { useEffect, useState, type ReactNode } from 'react';
import { api, type Stats, type InactiveRow } from '../lib/api';
import { Avatar, Card, Segmented, Empty, Loading, rateClass } from './bits';
import { haptic, openProfile } from '../lib/telegram';

type Tab = 'reyting' | 'yubormaganlar';

/// Yubormaganlarni guruhlar bo'yicha ajratamiz — murabbiy qaysi guruhda
/// muammo borligini bir qarashda ko'radi. Bir odam bir necha guruhda bo'lsa,
/// har birida ko'rinadi.
function groupInactive(rows: InactiveRow[]): [string, InactiveRow[]][] {
    const map = new Map<string, InactiveRow[]>();
    for (const r of rows) {
        for (const g of r.groups.length ? r.groups : ['Guruhsiz']) {
            if (!map.has(g)) map.set(g, []);
            map.get(g)!.push(r);
        }
    }
    return [...map.entries()].sort((a, b) => b[1].length - a[1].length);
}

export default function Ranking({
    group,
    onPick,
    children,
}: {
    group: string | null;
    onPick: (id: string) => void;
    children?: ReactNode;
}) {
    const [tab, setTab] = useState<Tab>('yubormaganlar');
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
        const req =
            tab === 'reyting'
                ? api.stats(days, group ?? undefined)
                : api.inactive(gapDays, group ?? undefined);
        req.then(res => {
            if (!live) return;
            if (tab === 'reyting') setStats(res as Stats);
            else setInactive(res as InactiveRow[]);
        })
            .catch(e => live && setError(e.message))
            .finally(() => live && setLoading(false));
        return () => {
            live = false;
        };
    }, [tab, days, gapDays, group]);

    return (
        <div className="screen">
            <div className="head">
                <div>
                    <h1>Reyting</h1>
                    <p className="sub">Intizom va e'tibor talab qiluvchilar</p>
                </div>
            </div>

            {children}

            <Segmented
                value={tab}
                onChange={v => {
                    haptic();
                    setTab(v);
                }}
                options={[
                    { value: 'yubormaganlar', label: 'Yubormaganlar' },
                    { value: 'reyting', label: 'Intizom' },
                ]}
            />

            {error && <div className="err">{error}</div>}

            {tab === 'reyting' ? (
                <>
                    <Segmented
                        value={days}
                        onChange={v => {
                            haptic();
                            setDays(v);
                        }}
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
                                <button
                                    key={r.id}
                                    className="row"
                                    onClick={() => {
                                        haptic();
                                        onPick(r.id);
                                    }}
                                >
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
                        onChange={v => {
                            haptic();
                            setGapDays(v);
                        }}
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
                        <Empty
                            icon="✅"
                            text={
                                group
                                    ? `Oxirgi ${gapDays} kunda bu guruhda hamma yuborgan`
                                    : `Oxirgi ${gapDays} kunda barcha guruhlarda hamma yuborgan`
                            }
                        />
                    ) : (
                        <>
                            <p style={{ color: 'var(--hint)', fontSize: 13, margin: '0 0 10px' }}>
                                {group ? 'Bu guruhda' : "Barcha guruhlar bo'ylab"} — jami{' '}
                                <b>{inactive.length}</b> kishi · <i>ismga bosing → Telegram profili</i>
                            </p>
                            {groupInactive(inactive).map(([groupName, rows]) => (
                                <Card key={groupName} title={`${groupName} — ${rows.length}`} tight>
                                    {rows.map(r => (
                                        <div key={r.id} className="row">
                                            {/* Ismga bosilsa — odamning Telegram profiliga o'tadi */}
                                            <button
                                                className="grow"
                                                style={{
                                                    display: 'flex',
                                                    alignItems: 'center',
                                                    gap: 12,
                                                    textAlign: 'left',
                                                    minWidth: 0,
                                                }}
                                                onClick={() => openProfile(r)}
                                            >
                                                <Avatar name={r.name} />
                                                <span className="grow">
                                                    <span className="name" style={{ display: 'block' }}>
                                                        {r.name}
                                                    </span>
                                                    <span className="meta" style={{ display: 'block' }}>
                                                        {r.lastMealDate
                                                            ? `Oxirgi: ${r.lastMealDate}`
                                                            : 'Hech qachon yubormagan'}
                                                    </span>
                                                </span>
                                            </button>
                                            <span className="pill warn">
                                                {r.daysSince === null ? '—' : `${r.daysSince} kun`}
                                            </span>
                                            {/* Tarixni ko'rish — alohida tugma */}
                                            <button
                                                className="row-action"
                                                aria-label="Tarixni ko'rish"
                                                onClick={() => {
                                                    haptic();
                                                    onPick(r.id);
                                                }}
                                            >
                                                📊
                                            </button>
                                        </div>
                                    ))}
                                </Card>
                            ))}
                        </>
                    )}
                </>
            )}
        </div>
    );
}
