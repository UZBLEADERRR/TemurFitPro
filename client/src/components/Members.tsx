import { useEffect, useMemo, useState } from 'react';
import { api, type GroupInfo, type MemberBrief } from '../lib/api';
import { Avatar, Card, Empty, Loading } from './bits';
import { haptic } from '../lib/telegram';

export default function Members({ onPick }: { onPick: (id: string) => void }) {
    const [rows, setRows] = useState<MemberBrief[] | null>(null);
    const [groups, setGroups] = useState<GroupInfo[]>([]);
    const [q, setQ] = useState('');
    const [error, setError] = useState('');

    useEffect(() => {
        api.members().then(setRows).catch((e: Error) => setError(e.message));
        api.groups().then(setGroups).catch(() => undefined);
    }, []);

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

            {groups.length > 1 && (
                <Card title="Guruhlar" tight>
                    {groups.map(g => (
                        <div key={g.id} className="row">
                            <div className="grow">
                                <div className="name">{g.title}</div>
                            </div>
                            <span className="pill">{g.members}</span>
                        </div>
                    ))}
                </Card>
            )}

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
