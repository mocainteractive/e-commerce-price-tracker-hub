/** Formattazione in convenzione italiana. */

export function formatPrice(value: number | null | undefined, currency = 'EUR'): string {
  if (value === null || value === undefined) return '—';
  return new Intl.NumberFormat('it-IT', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(value);
}

export function formatPercent(value: number | null | undefined, withSign = true): string {
  if (value === null || value === undefined) return '—';
  const formatted = new Intl.NumberFormat('it-IT', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(Math.abs(value));

  if (!withSign) return `${formatted}%`;
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  return `${sign}${formatted}%`;
}

export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return new Intl.NumberFormat('it-IT').format(value);
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('it-IT', { day: '2-digit', month: 'short', year: 'numeric' }).format(
    new Date(iso),
  );
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('it-IT', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}

/** "3 minuti fa", "2 giorni fa". */
export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return 'mai';

  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diffMs / 60000);
  const formatter = new Intl.RelativeTimeFormat('it-IT', { numeric: 'auto' });

  if (Math.abs(minutes) < 60) return formatter.format(-minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(-hours, 'hour');
  return formatter.format(-Math.round(hours / 24), 'day');
}

const AVAILABILITY_LABELS: Record<string, string> = {
  disponibile: 'Disponibile',
  non_disponibile: 'Non disponibile',
  preordine: 'Preordine',
  ordinabile: 'Ordinabile',
};

export function formatAvailability(value: string | null | undefined): string {
  if (!value) return 'Non rilevata';
  return AVAILABILITY_LABELS[value] ?? value;
}
