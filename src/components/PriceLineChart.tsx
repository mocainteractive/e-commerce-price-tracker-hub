/**
 * Grafico a linee dell'andamento prezzi (SVG inline, nessuna dipendenza).
 *
 * Scelte di design, deliberate:
 *   * una sola scala Y: prezzi in valuta, mai due assi;
 *   * linee da 2px, marker da 8px solo al passaggio del mouse;
 *   * griglia e assi recessivi, etichette sempre con i colori del testo;
 *   * legenda sempre presente (l'identita' non e' mai affidata al solo colore)
 *     e vista a tabella disponibile per lettura da tastiera e screen reader;
 *   * crosshair + tooltip: un grafico HTML e' interattivo per natura.
 */
import { useMemo, useRef, useState, useEffect } from 'react';
import { Table2, LineChart as LineChartIcon } from 'lucide-react';
import { formatPrice } from '../lib/format';

export interface ChartSeries {
  key: string;
  label: string;
  color: string;
  /** Punti ordinati per giorno crescente. I giorni mancanti creano un buco. */
  points: Array<{ day: string; price: number }>;
}

const PADDING = { top: 16, right: 16, bottom: 28, left: 56 };
const HEIGHT = 280;

export function PriceLineChart({
  series,
  currency = 'EUR',
  emptyLabel = 'Non ci sono ancora rilevazioni sufficienti per tracciare l\'andamento.',
}: {
  series: ChartSeries[];
  currency?: string;
  emptyLabel?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    const observer = new ResizeObserver(([entry]) => {
      setWidth(Math.max(entry.contentRect.width, 320));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const model = useMemo(() => buildModel(series, width), [series, width]);

  if (!model) {
    return (
      <div ref={containerRef}>
        <p className="py-12 text-center text-sm text-moca-gray">{emptyLabel}</p>
      </div>
    );
  }

  const { days, scaleX, scaleY, yTicks, xTicks, paths } = model;
  const innerWidth = width - PADDING.left - PADDING.right;

  return (
    <div ref={containerRef}>
      <div className="flex items-center justify-between gap-4 mb-3">
        {/* Legenda: presente sempre, anche con una sola serie evidenziata. */}
        <ul className="flex flex-wrap items-center gap-x-4 gap-y-1">
          {series.map((s) => (
            <li key={s.key} className="flex items-center gap-2 text-xs text-moca-black">
              <span
                className="h-2.5 w-2.5 rounded-full shrink-0"
                style={{ backgroundColor: s.color }}
                aria-hidden="true"
              />
              {s.label}
            </li>
          ))}
        </ul>

        <button
          type="button"
          onClick={() => setShowTable((v) => !v)}
          className="text-xs text-moca-gray hover:text-moca-black inline-flex items-center gap-1.5 shrink-0"
        >
          {showTable ? <LineChartIcon size={14} /> : <Table2 size={14} />}
          {showTable ? 'Grafico' : 'Tabella'}
        </button>
      </div>

      {showTable ? (
        <DataTable series={series} days={days} currency={currency} />
      ) : (
        <svg
          width={width}
          height={HEIGHT}
          role="img"
          aria-label={`Andamento prezzi: ${series.map((s) => s.label).join(', ')}`}
          onMouseLeave={() => setHoverIndex(null)}
          onMouseMove={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            const x = event.clientX - rect.left - PADDING.left;
            const ratio = innerWidth > 0 ? x / innerWidth : 0;
            const index = Math.round(ratio * (days.length - 1));
            setHoverIndex(index >= 0 && index < days.length ? index : null);
          }}
        >
          {/* Griglia recessiva */}
          {yTicks.map((tick) => (
            <g key={tick}>
              <line
                x1={PADDING.left}
                x2={width - PADDING.right}
                y1={scaleY(tick)}
                y2={scaleY(tick)}
                stroke="#E5E7EB"
                strokeWidth={1}
              />
              <text
                x={PADDING.left - 8}
                y={scaleY(tick)}
                textAnchor="end"
                dominantBaseline="middle"
                className="fill-moca-gray"
                fontSize={11}
              >
                {formatPrice(tick, currency)}
              </text>
            </g>
          ))}

          {xTicks.map(({ index, label }) => (
            <text
              key={index}
              x={scaleX(index)}
              y={HEIGHT - 8}
              textAnchor="middle"
              className="fill-moca-gray"
              fontSize={11}
            >
              {label}
            </text>
          ))}

          {/* Crosshair */}
          {hoverIndex !== null && (
            <line
              x1={scaleX(hoverIndex)}
              x2={scaleX(hoverIndex)}
              y1={PADDING.top}
              y2={HEIGHT - PADDING.bottom}
              stroke="#191919"
              strokeWidth={1}
              strokeDasharray="3 3"
              opacity={0.35}
            />
          )}

          {/* Serie */}
          {paths.map((path) => (
            <path
              key={path.key}
              d={path.d}
              fill="none"
              stroke={path.color}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ))}

          {/* Marker sul punto puntato dal mouse */}
          {hoverIndex !== null &&
            series.map((s) => {
              const point = s.points.find((p) => p.day === days[hoverIndex]);
              if (!point) return null;
              return (
                <circle
                  key={s.key}
                  cx={scaleX(hoverIndex)}
                  cy={scaleY(point.price)}
                  r={4.5}
                  fill={s.color}
                  stroke="#FFFFFF"
                  strokeWidth={2}
                />
              );
            })}
        </svg>
      )}

      {!showTable && hoverIndex !== null && (
        <Tooltip series={series} day={days[hoverIndex]} currency={currency} />
      )}
    </div>
  );
}

function Tooltip({
  series,
  day,
  currency,
}: {
  series: ChartSeries[];
  day: string;
  currency: string;
}) {
  const rows = series
    .map((s) => ({ series: s, point: s.points.find((p) => p.day === day) }))
    .filter((row) => row.point);

  if (rows.length === 0) return null;

  return (
    <div className="mt-3 inline-flex flex-wrap items-center gap-x-5 gap-y-1 rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs">
      <span className="font-semibold text-moca-black">{formatDay(day)}</span>
      {rows.map(({ series: s, point }) => (
        <span key={s.key} className="flex items-center gap-2 text-moca-black">
          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: s.color }} aria-hidden="true" />
          {s.label}
          <strong className="tabular-nums">{formatPrice(point!.price, currency)}</strong>
        </span>
      ))}
    </div>
  );
}

function DataTable({
  series,
  days,
  currency,
}: {
  series: ChartSeries[];
  days: string[];
  currency: string;
}) {
  // Dal piu' recente: e' l'ordine in cui si legge un andamento prezzi.
  const ordered = [...days].reverse().slice(0, 30);

  return (
    <div className="overflow-x-auto" style={{ maxHeight: HEIGHT }}>
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-white">
          <tr className="text-left text-xs uppercase tracking-wide text-moca-gray">
            <th className="py-2 pr-4 font-semibold">Giorno</th>
            {series.map((s) => (
              <th key={s.key} className="py-2 pr-4 font-semibold">
                {s.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ordered.map((day) => (
            <tr key={day} className="border-t border-gray-100">
              <td className="py-2 pr-4 text-moca-gray whitespace-nowrap">{formatDay(day)}</td>
              {series.map((s) => {
                const point = s.points.find((p) => p.day === day);
                return (
                  <td key={s.key} className="py-2 pr-4 tabular-nums">
                    {point ? formatPrice(point.price, currency) : 'n.d.'}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// -----------------------------------------------------------------------------

function buildModel(series: ChartSeries[], width: number) {
  const days = [...new Set(series.flatMap((s) => s.points.map((p) => p.day)))].sort();
  const prices = series.flatMap((s) => s.points.map((p) => p.price));

  // Con un solo giorno non c'e' un andamento da mostrare.
  if (days.length < 2 || prices.length === 0) return null;

  const rawMin = Math.min(...prices);
  const rawMax = Math.max(...prices);
  // Un margine del 6% evita che le linee tocchino i bordi del riquadro.
  const margin = Math.max((rawMax - rawMin) * 0.06, rawMax * 0.01, 0.5);
  const min = Math.max(0, rawMin - margin);
  const max = rawMax + margin;

  const innerWidth = width - PADDING.left - PADDING.right;
  const innerHeight = HEIGHT - PADDING.top - PADDING.bottom;

  const scaleX = (index: number) =>
    PADDING.left + (days.length === 1 ? innerWidth / 2 : (index / (days.length - 1)) * innerWidth);

  const scaleY = (value: number) =>
    PADDING.top + innerHeight - ((value - min) / (max - min || 1)) * innerHeight;

  const yTicks = Array.from({ length: 5 }, (_, i) => min + ((max - min) / 4) * i);

  // Al massimo 6 etichette sull'asse X: oltre si sovrappongono.
  const step = Math.max(1, Math.ceil(days.length / 6));
  const xTicks = days
    .map((day, index) => ({ index, label: formatDayShort(day) }))
    .filter(({ index }) => index % step === 0);

  const paths = series.map((s) => {
    const byDay = new Map(s.points.map((p) => [p.day, p.price]));
    let d = '';
    let penDown = false;

    days.forEach((day, index) => {
      const price = byDay.get(day);
      if (price === undefined) {
        // Giorno senza rilevazione: interrompiamo la linea invece di
        // interpolare un prezzo che non e' mai esistito.
        penDown = false;
        return;
      }
      d += `${penDown ? 'L' : 'M'}${scaleX(index).toFixed(1)},${scaleY(price).toFixed(1)}`;
      penDown = true;
    });

    return { key: s.key, color: s.color, d };
  });

  return { days, scaleX, scaleY, yTicks, xTicks, paths };
}

function formatDay(day: string): string {
  return new Intl.DateTimeFormat('it-IT', { day: '2-digit', month: 'long' }).format(new Date(day));
}

function formatDayShort(day: string): string {
  return new Intl.DateTimeFormat('it-IT', { day: '2-digit', month: '2-digit' }).format(new Date(day));
}
