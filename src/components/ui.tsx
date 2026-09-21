/**
 * Componenti di base del Design System v2.0.
 * Nessuna emoji: tutte le icone vengono da lucide-react.
 */
import type { ReactNode } from 'react';
import { AlertCircle, Inbox, type LucideIcon } from 'lucide-react';
import type { PricePosition } from '../lib/types';

export function Card({
  title,
  action,
  children,
  className = '',
}: {
  title?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`bg-white shadow-sm rounded-xl p-6 ${className}`}>
      {(title || action) && (
        <div className="flex items-center justify-between gap-4 mb-4">
          {title && <h2 className="text-lg font-semibold text-moca-black">{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function StatTile({
  label,
  value,
  hint,
  icon: Icon,
  tone = 'neutro',
}: {
  label: string;
  value: string;
  hint?: string;
  icon?: LucideIcon;
  tone?: 'neutro' | 'positivo' | 'attenzione' | 'critico';
}) {
  const toneClass = {
    neutro: 'text-moca-black',
    positivo: 'text-success',
    attenzione: 'text-warning',
    critico: 'text-moca-red',
  }[tone];

  return (
    <div className="bg-white shadow-sm rounded-xl p-5">
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-moca-gray">{label}</p>
        {Icon && <Icon size={18} className="text-moca-gray shrink-0" />}
      </div>
      <p className={`mt-2 text-3xl font-semibold tabular-nums ${toneClass}`}>{value}</p>
      {hint && <p className="mt-1 text-xs text-moca-gray">{hint}</p>}
    </div>
  );
}

const POSITION_STYLES: Record<PricePosition, { label: string; className: string }> = {
  migliore: { label: 'Prezzo migliore', className: 'bg-success/10 text-success' },
  allineato: { label: 'Allineato', className: 'bg-chart-2/10 text-chart-2' },
  caro: { label: 'Fuori prezzo', className: 'bg-moca-red-light text-moca-red' },
  sconosciuto: { label: 'Non confrontato', className: 'bg-gray-100 text-moca-gray' },
};

export function PositionBadge({ position }: { position: PricePosition }) {
  const style = POSITION_STYLES[position];
  return (
    <span className={`px-2 py-0.5 text-xs font-medium rounded-full whitespace-nowrap ${style.className}`}>
      {style.label}
    </span>
  );
}

export function Badge({
  children,
  tone = 'neutro',
}: {
  children: ReactNode;
  tone?: 'neutro' | 'positivo' | 'attenzione' | 'critico' | 'info';
}) {
  const toneClass = {
    neutro: 'bg-gray-100 text-moca-gray',
    positivo: 'bg-success/10 text-success',
    attenzione: 'bg-warning/10 text-warning',
    critico: 'bg-moca-red-light text-moca-red',
    info: 'bg-chart-2/10 text-chart-2',
  }[tone];

  return (
    <span className={`px-2 py-0.5 text-xs font-medium rounded-full whitespace-nowrap ${toneClass}`}>
      {children}
    </span>
  );
}

export function Spinner({ size = 24 }: { size?: number }) {
  return (
    <div
      className="animate-spin border-2 border-moca-red border-t-transparent rounded-full"
      style={{ width: size, height: size }}
      role="status"
      aria-label="Caricamento in corso"
    />
  );
}

export function LoadingBlock({ label = 'Caricamento in corso' }: { label?: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 gap-3">
      <Spinner size={28} />
      <p className="text-sm text-moca-gray">{label}</p>
    </div>
  );
}

export function EmptyState({
  title,
  description,
  icon: Icon = Inbox,
  action,
}: {
  title: string;
  description: string;
  icon?: LucideIcon;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-14 text-center gap-3">
      <Icon size={40} className="text-moca-gray" />
      <h3 className="text-base font-semibold text-moca-black">{title}</h3>
      <p className="text-sm text-moca-gray max-w-md">{description}</p>
      {action}
    </div>
  );
}

export function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex items-start gap-3 bg-moca-red-light border border-moca-red/30 text-moca-black rounded-xl p-4">
      <AlertCircle size={20} className="text-moca-red shrink-0 mt-0.5" />
      <div className="flex-1">
        <p className="text-sm font-medium">{message}</p>
        {onRetry && (
          <button onClick={onRetry} className="mt-2 text-sm font-semibold text-moca-red hover:underline">
            Riprova
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Barra di posizionamento: dove sta il nostro prezzo fra il minimo e il
 * massimo di mercato. Il valore e' sempre anche scritto a testo, mai
 * affidato al solo colore.
 */
export function PriceRangeBar({
  min,
  max,
  own,
  format,
}: {
  min: number;
  max: number;
  own: number | null;
  format: (value: number | null) => string;
}) {
  const span = Math.max(max - min, 0.01);
  const position = own !== null ? Math.min(Math.max(((own - min) / span) * 100, 0), 100) : null;

  return (
    <div>
      <div className="relative h-2 rounded-full bg-gradient-to-r from-success/30 via-gray-200 to-moca-red/30">
        {position !== null && (
          <div
            className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 h-4 w-4 rounded-full bg-moca-red ring-2 ring-white"
            style={{ left: `${position}%` }}
            title={`Il tuo prezzo: ${format(own)}`}
          />
        )}
      </div>
      <div className="flex justify-between mt-2 text-xs text-moca-gray tabular-nums">
        <span>Min {format(min)}</span>
        <span>Max {format(max)}</span>
      </div>
    </div>
  );
}
