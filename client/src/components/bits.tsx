import type { ReactNode } from 'react';
import { MEALS, type MealStatus, type MealKey } from '../lib/api';

export function Avatar({ name }: { name: string }) {
    // Ism bo'yicha barqaror rang — har safar bir xil ko'rinadi
    const hue = [...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
    const initials = name
        .split(/\s+/)
        .slice(0, 2)
        .map(w => w[0]?.toUpperCase() ?? '')
        .join('');
    return (
        <div className="avatar" style={{ background: `hsl(${hue} 62% 48%)` }}>
            {initials || '?'}
        </div>
    );
}

export function MealDots({ meals }: { meals: Record<MealKey, MealStatus> }) {
    return (
        <div className="dots">
            {MEALS.map(m => (
                <span key={m.key} className={`dot ${meals[m.key]}`} title={m.label}>
                    {m.short}
                </span>
            ))}
        </div>
    );
}

export function Card({ title, children, tight }: { title?: string; children: ReactNode; tight?: boolean }) {
    return (
        <div className={`card${tight ? ' tight' : ''}`}>
            {title && <p className="card-title">{title}</p>}
            {children}
        </div>
    );
}

export function Segmented<T extends string | number>({
    options,
    value,
    onChange,
}: {
    options: { value: T; label: string }[];
    value: T;
    onChange: (v: T) => void;
}) {
    return (
        <div className="seg">
            {options.map(o => (
                <button key={String(o.value)} className={o.value === value ? 'on' : ''} onClick={() => onChange(o.value)}>
                    {o.label}
                </button>
            ))}
        </div>
    );
}

export function Switch({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
    return <button className={`switch${on ? ' on' : ''}`} onClick={() => onChange(!on)} aria-pressed={on} />;
}

export function Empty({ icon, text }: { icon: string; text: string }) {
    return (
        <div className="empty">
            <span className="ic">{icon}</span>
            {text}
        </div>
    );
}

export function Loading({ rows = 4 }: { rows?: number }) {
    return (
        <>
            {Array.from({ length: rows }, (_, i) => (
                <div key={i} className="skeleton" />
            ))}
        </>
    );
}

export function rateClass(rate: number): string {
    if (rate >= 80) return 'good';
    if (rate >= 50) return 'warn';
    return 'bad';
}
