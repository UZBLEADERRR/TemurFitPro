import { useEffect, useState } from 'react';
import { api, tenantId, type Me, type GroupInfo } from './lib/api';
import { haptic } from './lib/telegram';
import Today from './components/Today';
import Ranking from './components/Ranking';
import Members from './components/Members';
import SettingsScreen from './components/SettingsScreen';
import MemberSheet from './components/MemberSheet';
import GroupFilter from './components/GroupFilter';
import { Empty, Loading } from './components/bits';

type Tab = 'today' | 'rank' | 'members' | 'settings';

const TABS: { key: Tab; icon: string; label: string; coachOnly?: boolean }[] = [
    { key: 'today', icon: '🍽', label: 'Bugun' },
    { key: 'rank', icon: '📊', label: 'Reyting', coachOnly: true },
    { key: 'members', icon: '👥', label: "A'zolar", coachOnly: true },
    { key: 'settings', icon: '⚙️', label: 'Sozlash', coachOnly: true },
];

export default function App() {
    const [me, setMe] = useState<Me | null>(null);
    const [error, setError] = useState('');
    const [tab, setTab] = useState<Tab>('today');
    const [picked, setPicked] = useState<string | null>(null);
    /// null = barcha guruhlar bo'ylab umumiy ko'rinish
    const [group, setGroup] = useState<string | null>(null);
    const [groups, setGroups] = useState<GroupInfo[]>([]);

    useEffect(() => {
        if (!tenantId()) {
            setError("Havola noto'g'ri — mini ilovani bot tugmasi orqali oching.");
            return;
        }
        api.me()
            .then(setMe)
            .catch(e => setError(e.message));
        api.groups().then(setGroups).catch(() => undefined);
    }, []);

    if (error) {
        return (
            <div className="app">
                <div className="screen">
                    <Empty icon="⚠️" text={error} />
                </div>
            </div>
        );
    }

    if (!me) {
        return (
            <div className="app">
                <div className="screen">
                    <Loading rows={5} />
                </div>
            </div>
        );
    }

    const isCoach = me.role === 'coach' || me.role === 'super';
    const visible = TABS.filter(t => !t.coachOnly || isCoach);
    const filter = <GroupFilter groups={groups} value={group} onChange={setGroup} />;

    return (
        <div className="app">
            {tab === 'today' && (
                <Today me={me} group={group} onPick={setPicked}>
                    {filter}
                </Today>
            )}
            {tab === 'rank' && isCoach && (
                <Ranking group={group} onPick={setPicked}>
                    {filter}
                </Ranking>
            )}
            {tab === 'members' && isCoach && (
                <Members group={group} onPick={setPicked}>
                    {filter}
                </Members>
            )}
            {tab === 'settings' && isCoach && <SettingsScreen />}

            {picked && <MemberSheet id={picked} onClose={() => setPicked(null)} />}

            {visible.length > 1 && (
                <nav className="nav">
                    {visible.map(t => (
                        <button
                            key={t.key}
                            className={tab === t.key ? 'on' : ''}
                            onClick={() => {
                                haptic();
                                setTab(t.key);
                            }}
                        >
                            <span className="ic">{t.icon}</span>
                            {t.label}
                        </button>
                    ))}
                </nav>
            )}
        </div>
    );
}
