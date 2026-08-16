import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, type GroupInfo, type MemberBrief } from '../lib/api';
import { Avatar, Card, Empty, Loading } from './bits';
import { haptic } from '../lib/telegram';

export default function Members({
    group,
    onPick,
    children,
}: {
    group: string | null;
    onPick: (id: string) => void;
    children?: ReactNode;
}) {
    const [rows, setRows] = useState<MemberBrief[] | null>(null);
    const [groups, setGroups] = useState<GroupInfo[]>([]);
    const [q, setQ] = useState('');
    const [error, setError] = useState('');

    useEffect(() => {
        setRows(null);
        api.members(group ?? undefined)
            .then(setRows)
            .catch((e: Error) => setError(e.message));
        api.groups().then(setGroups).catch(() => undefined);
    }, [group]);

    const filtered = useMemo(() => {
        if (!rows) return null;
        const needle = q.trim().toLowerCase();
        if (!needle) return rows;
        return rows.filter(
            r => r.name.toLowerCase().includes(needle) || (r.username ?? '').toLowerCase().includes(needle),
        );
    }, [rows, q]);

    return (
        <div className="screen">
            <div className="head">
                <div>
                    <h1>A'zolar</h1>
                    <p className="sub">
                        {rows ? `${rows.length} kishi` : '…'} · {groups.length} guruh
                    </p>
                </div>
            </div>

            {children}

            {error && <div className="err">{error}</div>}

            <input
                type="text"
                value={q}
                onChange={e => setQ(e.target.value)}
                placeholder="Ism bo'yicha qidirish"
                style={{
                    width: '100%',
                    background: 'var(--card)',
                    border: '1px solid transparent',
                    borderRadius: 13,
                    padding: '11px 14px',
                    marginBottom: 12,
                }}
            />

            {!filtered ? (
                <Loading />
            ) : filtered.length === 0 ? (
                <Empty icon="🔍" text="Hech kim topilmadi" />
            ) : (
                <Card tight>
                    {filtered.map(r => (
                        <button key={r.id} className="row" onClick={() => { haptic(); onPick(r.id); }}>
                            <Avatar name={r.name} />
                            <div className="grow">
                                <div className="name">
                                    {r.name}
                                    {r.role === 'owner' && ' 👑'}
                                    {r.role === 'coach' && ' 🎯'}
                                </div>
                                <div className="meta">
                                    {r.groups.length ? r.groups.join(' · ') : 'Guruhga biriktirilmagan'}
                                </div>
                            </div>
                            <span style={{ color: 'var(--hint)' }}>›</span>
                        </button>
                    ))}
                </Card>
            )}
        </div>
    );
}
