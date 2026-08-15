import { useEffect, useState } from 'react';
import { api, type Settings, type BusinessInfo } from '../lib/api';
import { Card, Switch, Loading } from './bits';
import { haptic } from '../lib/telegram';

export default function SettingsScreen({ agentName }: { agentName: string }) {
    const [s, setS] = useState<Settings | null>(null);
    const [biz, setBiz] = useState<BusinessInfo | null>(null);
    const [dirty, setDirty] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const [saved, setSaved] = useState(false);

    useEffect(() => {
        api.settings().then(setS).catch(e => setError(e.message));
        api.business().then(setBiz).catch(() => undefined);
    }, []);

    const patch = <K extends keyof Settings>(key: K, value: Settings[K]) => {
        setS(prev => (prev ? { ...prev, [key]: value } : prev));
        setDirty(true);
        setSaved(false);
    };

    const save = async () => {
        if (!s) return;
        setSaving(true);
        setError('');
        try {
            await api.saveSettings(s);
            setDirty(false);
            setSaved(true);
            haptic('success');
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Saqlanmadi');
            haptic('error');
        } finally {
            setSaving(false);
        }
    };

    if (error && !s) return <div className="screen"><div className="err">{error}</div></div>;
    if (!s) return <div className="screen"><Loading rows={5} /></div>;

    return (
        <div className="screen">
            <div className="head">
                <div>
                    <h1>Sozlamalar</h1>
                    <p className="sub">Ovqat vaqtlari va eslatmalar</p>
                </div>
            </div>

            {error && <div className="err">{error}</div>}

            <Card title="Ovqat vaqtlari">
                <div className="field">
                    <label>🌅 Nonushta</label>
                    <input type="time" value={s.breakfastTime} onChange={e => patch('breakfastTime', e.target.value)} />
                </div>
                <div className="field">
                    <label>🌞 Tushlik</label>
                    <input type="time" value={s.lunchTime} onChange={e => patch('lunchTime', e.target.value)} />
                </div>
                <div className="field">
                    <label>🌙 Kechki</label>
                    <input type="time" value={s.dinnerTime} onChange={e => patch('dinnerTime', e.target.value)} />
                </div>
                <div className="field">
                    <div>
                        <label>Kechikish chegarasi</label>
                        <div className="desc">Shu daqiqadan keyin "kech" hisoblanadi</div>
                    </div>
                    <input
                        type="number"
                        min={0}
                        max={720}
                        value={s.graceMinutes}
                        onChange={e => patch('graceMinutes', Number(e.target.value))}
                    />
                </div>
            </Card>

            <Card title="Eslatmalar">
                <div className="field">
                    <div>
                        <label>Takrorlash oralig'i</label>
                        <div className="desc">Daqiqada</div>
                    </div>
                    <input
                        type="number"
                        min={5}
                        max={1440}
                        value={s.reminderInterval}
                        onChange={e => patch('reminderInterval', Number(e.target.value))}
                    />
                </div>
                <div className="field">
                    <div>
                        <label>Maksimal eslatma</label>
                        <div className="desc">Bir ovqat uchun</div>
                    </div>
                    <input
                        type="number"
                        min={0}
                        max={20}
                        value={s.maxReminders}
                        onChange={e => patch('maxReminders', Number(e.target.value))}
                    />
                </div>
                <div className="field">
                    <div>
                        <label>Eslatmani o'chirish</label>
                        <div className="desc">Ovqat kelganda xabar guruhdan olib tashlansin</div>
                    </div>
                    <Switch on={s.autoDeleteReminders} onChange={v => patch('autoDeleteReminders', v)} />
                </div>
                <div className="field">
                    <div>
                        <label>Rasm majburiy</label>
                        <div className="desc">O'chsa, faqat hashtag ham qabul qilinadi</div>
                    </div>
                    <Switch on={s.requirePhoto} onChange={v => patch('requirePhoto', v)} />
                </div>
            </Card>

            <Card title={`${agentName} — AI yordamchi`}>
                <div className="field">
                    <label>Ismi</label>
                    <input
                        type="text"
                        value={s.agentName}
                        maxLength={40}
                        onChange={e => patch('agentName', e.target.value)}
                    />
                </div>
                <div style={{ paddingTop: 10 }}>
                    <label style={{ fontSize: 14 }}>Yozish uslubim</label>
                    <div className="desc" style={{ fontSize: 12, color: 'var(--hint)', margin: '2px 0 8px' }}>
                        AI a'zolarga xabarlarni aynan shu uslubda yozadi
                    </div>
                    <textarea
                        value={s.coachStyle}
                        maxLength={2000}
                        placeholder="Masalan: Qisqa yozaman, hurmat bilan lekin qat'iy. Doim ismini aytaman va oxirida bitta motivatsion jumla qo'shaman."
                        onChange={e => patch('coachStyle', e.target.value)}
                    />
                </div>
            </Card>

            <Card title="Kalit so'zlar">
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {(
                        [
                            ['breakfastWords', '🌅 Nonushta'],
                            ['lunchWords', '🌞 Tushlik'],
                            ['dinnerWords', '🌙 Kechki'],
                        ] as const
                    ).map(([key, label]) => (
                        <div key={key}>
                            <label style={{ fontSize: 13, color: 'var(--hint)' }}>{label}</label>
                            <input
                                type="text"
                                value={s[key]}
                                onChange={e => patch(key, e.target.value)}
                                style={{
                                    width: '100%',
                                    marginTop: 4,
                                    textAlign: 'left',
                                    background: 'var(--bg)',
                                    border: '1px solid transparent',
                                    borderRadius: 9,
                                    padding: '8px 10px',
                                }}
                            />
                        </div>
                    ))}
                </div>
            </Card>

            {biz && (
                <Card title="Telegram Business">
                    {biz.ready ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span className="pill ok">Ulangan</span>
                            <span style={{ fontSize: 13, color: 'var(--hint)' }}>
                                Xabarlar {biz.connection?.user} nomidan yuboriladi
                            </span>
                        </div>
                    ) : (
                        <div style={{ fontSize: 13, color: 'var(--hint)', lineHeight: 1.6 }}>
                            <span className="pill warn">Ulanmagan</span>
                            <p style={{ margin: '10px 0 0' }}>
                                Xabarlarni <b>o'z nomingizdan</b> yuborish uchun: Telegram → Sozlamalar → Telegram
                                Business → Chatbots → botni tanlang va <b>"Reply to messages"</b> ni yoqing.
                            </p>
                        </div>
                    )}
                </Card>
            )}

            <button className="btn" onClick={save} disabled={!dirty || saving}>
                {saving ? 'Saqlanmoqda…' : saved && !dirty ? '✓ Saqlandi' : 'Saqlash'}
            </button>
        </div>
    );
}
