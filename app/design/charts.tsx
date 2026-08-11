import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { formatMoney, type Cents } from "~/engine/money";

/**
 * Charts are hand-built SVG rather than a charting library.
 *
 * A library would have to be re-themed to match the design system anyway, and
 * fought with over mark geometry. Building them means the 2px surface gaps,
 * rounded data-ends and crosshair behaviour are exactly as specified, and the
 * whole chart layer costs nothing at runtime.
 */

/* ------------------------------------------------------------- measurement */

function useMeasuredWidth<T extends HTMLElement>(fallback = 720) {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;

    const update = () => setWidth(node.clientWidth || fallback);
    update();

    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, [fallback]);

  return [ref, width] as const;
}

/* -------------------------------------------------------------- geometry */

/** Bar path with the data-end rounded and the baseline end square. */
function barPath(x: number, y: number, w: number, h: number, r = 0): string {
  if (h <= 0) return "";
  const radius = Math.min(r, w / 2, h);

  // Positive bars round the top; negative bars grow downward and round the
  // bottom, so the rounded end is always the end that carries the value.
  return [
    `M${x},${y + h}`,
    `L${x},${y + radius}`,
    `Q${x},${y} ${x + radius},${y}`,
    `L${x + w - radius},${y}`,
    `Q${x + w},${y} ${x + w},${y + radius}`,
    `L${x + w},${y + h}`,
    "Z",
  ].join(" ");
}

function barPathDown(x: number, y: number, w: number, h: number, r = 0): string {
  if (h <= 0) return "";
  const radius = Math.min(r, w / 2, h);
  return [
    `M${x},${y}`,
    `L${x},${y + h - radius}`,
    `Q${x},${y + h} ${x + radius},${y + h}`,
    `L${x + w - radius},${y + h}`,
    `Q${x + w},${y + h} ${x + w},${y + h - radius}`,
    `L${x + w},${y}`,
    "Z",
  ].join(" ");
}

function linePath(points: { x: number; y: number }[]): string {
  return points
    .map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(2)},${p.y.toFixed(2)}`)
    .join(" ");
}

function niceTicks(min: number, max: number, count = 4): number[] {
  if (min === max) return [min];
  const span = max - min;
  const raw = span / count;
  const magnitude = 10 ** Math.floor(Math.log10(Math.abs(raw) || 1));
  const step =
    [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= raw) ??
    10 * magnitude;

  const ticks: number[] = [];
  const start = Math.ceil(min / step) * step;
  for (let v = start; v <= max + step * 0.001; v += step) ticks.push(v);
  return ticks;
}

const shortMoney = (cents: Cents) =>
  formatMoney(cents, "USD", { compact: true, decimals: false });

/* --------------------------------------------------------------- tooltip */

interface TooltipState {
  x: number;
  y: number;
  title: string;
  rows: { label: string; value: string; color?: string }[];
}

function Tooltip({ state, width }: { state: TooltipState | null; width: number }) {
  if (!state) return null;

  // Keep the bubble inside the card at both edges.
  const clampedX = Math.max(80, Math.min(width - 80, state.x));

  return (
    <div className="chart-tooltip" style={{ left: clampedX, top: state.y }}>
      <div className="chart-tooltip-title">{state.title}</div>
      {state.rows.map((row) => (
        <div className="chart-tooltip-row" key={row.label}>
          <span className="label">
            {row.color && (
              <span className="legend-swatch" style={{ background: row.color }} />
            )}
            {row.label}
          </span>
          <span className="value">{row.value}</span>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------ time series */

export interface TimeSeriesPoint {
  date: Date;
  values: Record<string, number>;
}

export function TimeSeriesChart({
  data,
  series,
  timeZone,
  height = 240,
  format = shortMoney,
  zeroLine = false,
}: {
  data: TimeSeriesPoint[];
  series: {
    key: string;
    label: string;
    color: string;
    /** Fill a soft gradient under this series — reserved for the headline. */
    area?: boolean;
  }[];
  /** The merchant's IANA zone; chart dates name shop-local calendar buckets. */
  timeZone: string;
  height?: number;
  format?: (v: number) => string;
  zeroLine?: boolean;
}) {
  const [ref, width] = useMeasuredWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const gradientId = useId().replace(/[^a-zA-Z0-9_-]/g, "");

  // Changing the window swaps the data under the same component; keying the
  // marks on the data's shape replays the draw-in instead of snapping.
  const drawKey = `${data.length}-${data[0]?.date.getTime() ?? 0}-${data.at(-1)?.date.getTime() ?? 0}`;

  if (data.length === 0) {
    return <div className="empty">No data in this range.</div>;
  }

  // Right padding leaves room for the end-labels rather than clipping them.
  /*
   * No outboard gutter for the end labels any more — see the note where they
   * are drawn. "Profit before paid marketing" needs ~200px at this size and a
   * gutter that wide eats the plot; the labels sit inside it instead.
   */
  const pad = { top: 12, right: 16, bottom: 26, left: 52 };
  const plotW = Math.max(1, width - pad.left - pad.right);
  const plotH = Math.max(1, height - pad.top - pad.bottom);

  const all = data.flatMap((d) => series.map((s) => d.values[s.key] ?? 0));
  const rawMin = Math.min(...all, zeroLine ? 0 : Infinity);
  const rawMax = Math.max(...all, 0);
  const min = rawMin === rawMax ? rawMin - 1 : rawMin;
  const max = rawMin === rawMax ? rawMax + 1 : rawMax;

  const xAt = (i: number) =>
    pad.left + (data.length === 1 ? plotW / 2 : (i / (data.length - 1)) * plotW);
  const yAt = (v: number) => pad.top + plotH - ((v - min) / (max - min)) * plotH;

  const ticks = niceTicks(min, max, 4);

  const onMove = (event: React.MouseEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const relative = event.clientX - rect.left - pad.left;
    const index = Math.round((relative / plotW) * (data.length - 1));
    setHover(Math.max(0, Math.min(data.length - 1, index)));
  };

  // A range switch replaces the dataset without any mouse event firing (browser
  // Back, or keyboard-activating a range link), so a hover index captured on the
  // old, longer array can outlive it. Clamping here rather than trusting the
  // index keeps the crosshair from dereferencing past the end.
  const hoverIndex =
    hover === null ? null : Math.min(hover, data.length - 1);
  const point = hoverIndex !== null ? data[hoverIndex] : null;

  return (
    <div className="chart-holder" ref={ref}>
      <svg
        className="chart"
        width={width}
        height={height}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        role="img"
        aria-label={`${series.map((s) => s.label).join(" and ")} over time`}
      >
        {ticks.map((tick) => (
          <g key={tick}>
            <line
              className="grid-line"
              x1={pad.left}
              x2={width - pad.right}
              y1={yAt(tick)}
              y2={yAt(tick)}
            />
            <text x={pad.left - 8} y={yAt(tick) + 3} textAnchor="end">
              {format(tick)}
            </text>
          </g>
        ))}

        {zeroLine && min < 0 && (
          <line
            className="axis-line"
            x1={pad.left}
            x2={width - pad.right}
            y1={yAt(0)}
            y2={yAt(0)}
          />
        )}

        <defs>
          {series
            .filter((s) => s.area)
            .map((s) => (
              <linearGradient
                key={s.key}
                id={`${gradientId}-${s.key}`}
                x1="0"
                y1="0"
                x2="0"
                y2="1"
              >
                <stop offset="0%" stopColor={s.color} stopOpacity={0.16} />
                <stop offset="100%" stopColor={s.color} stopOpacity={0} />
              </linearGradient>
            ))}
        </defs>

        {/* gradient wash under the headline series, drawn behind every line */}
        {series
          .filter((s) => s.area)
          .map((s) => {
            const floor = pad.top + plotH;
            const line = data
              .map(
                (d, i) =>
                  `${i === 0 ? "M" : "L"}${xAt(i).toFixed(2)},${yAt(d.values[s.key] ?? 0).toFixed(2)}`,
              )
              .join(" ");
            return (
              <path
                key={`area-${s.key}-${drawKey}`}
                className="area-fade"
                d={`${line} L${xAt(data.length - 1).toFixed(2)},${floor} L${xAt(0).toFixed(2)},${floor} Z`}
                fill={`url(#${gradientId}-${s.key})`}
              />
            );
          })}

        {series.map((s) => (
          <path
            key={`${s.key}-${drawKey}`}
            className="draw"
            pathLength={1}
            d={linePath(
              data.map((d, i) => ({ x: xAt(i), y: yAt(d.values[s.key] ?? 0) })),
            )}
            fill="none"
            stroke={s.color}
            strokeWidth={1.6}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}

        {/*
          * Direct labels at the line ends.
          *
          * A legend alone makes the reader hold a colour in working memory and
          * carry it across the plot; naming each line where it finishes means
          * identity never depends on colour at all, which is also what keeps
          * this readable for a colourblind reader. Only for four series or
          * fewer — past that the labels collide and the legend has to carry it.
          *
          * Nudged apart when two lines finish within a label's height of each
          * other, so the two names never overlap.
          */}
        {series.length <= 4 &&
          (() => {
            /*
             * Clear of the line, not merely above its last point.
             *
             * The label is right-aligned and long — "Profit before paid
             * marketing" runs ~180px — so it hangs back over a stretch of plot
             * where the line is free to climb. Offsetting from the final point
             * alone put the text straight along a rising tail, and the knockout
             * that keeps it readable then bit a visible gap out of the series.
             *
             * So each label clears the highest point its own line reaches
             * underneath it. The x-span is estimated from the glyph count
             * because SVG text cannot be measured before layout; it only has to
             * be close, and erring wide errs safe.
             */
            const labelSpan = (label: string) =>
              Math.min(label.length * 7.2, plotW);

            const highestUnder = (key: string, span: number) => {
              const from = width - pad.right - span;
              let top = Infinity;
              data.forEach((d, i) => {
                if (xAt(i) < from) return;
                top = Math.min(top, yAt(d.values[key] ?? 0));
              });
              return Number.isFinite(top)
                ? top
                : yAt(data[data.length - 1]?.values[key] ?? 0);
            };

            const ends = series
              .map((s) => ({ s, y: highestUnder(s.key, labelSpan(s.label)) }))
              .sort((a, b) => a.y - b.y);
            let previous = -Infinity;
            return ends.map(({ s, y }) => {
              const placed = Math.max(y, previous + 12);
              previous = placed;
              return (
                /*
                 * Inside the plot, right-aligned, sitting just above the line's
                 * final point.
                 *
                 * These used to hang in a 96px gutter outside the plot, which
                 * silently clipped every label longer than that — including
                 * "Profit before paid marketing", the one label on this chart
                 * that must never be abbreviated, because an unqualified
                 * "PROFIT" is exactly the claim this product refuses to make.
                 * Widening the gutter to fit it would have cost a fifth of the
                 * plot; putting the text inside costs nothing.
                 */
                <text
                  key={`end-${s.key}`}
                  x={width - pad.right - 2}
                  y={placed - 14}
                  textAnchor="end"
                  className="series-end-label"
                  style={{ fill: s.color }}
                >
                  {s.label}
                </text>
              );
            });
          })()}

        {hoverIndex !== null && point && (
          <>
            <line
              className="crosshair"
              x1={xAt(hoverIndex)}
              x2={xAt(hoverIndex)}
              y1={pad.top}
              y2={pad.top + plotH}
            />
            {series.map((s) => (
              <circle
                key={s.key}
                cx={xAt(hoverIndex)}
                cy={yAt(point.values[s.key] ?? 0)}
                r={4.5}
                fill={s.color}
                stroke="var(--plane)"
                strokeWidth={2}
              />
            ))}
          </>
        )}

        {data.map((d, i) =>
          i % Math.ceil(data.length / 7) === 0 ? (
            <text key={i} x={xAt(i)} y={height - 8} textAnchor="middle">
              {d.date.toLocaleDateString("en-US", {
                timeZone,
                month: "short",
                day: "numeric",
              })}
            </text>
          ) : null,
        )}
      </svg>

      <Tooltip
        width={width}
        state={
          point
            ? {
                x: xAt(hoverIndex!),
                y: pad.top + 6,
                title: point.date.toLocaleDateString("en-US", {
                  timeZone,
                  weekday: "short",
                  month: "short",
                  day: "numeric",
                }),
                rows: series.map((s) => ({
                  label: s.label,
                  value: format(point.values[s.key] ?? 0),
                  color: s.color,
                })),
              }
            : null
        }
      />
    </div>
  );
}

/* --------------------------------------------------------------- bar chart */

export function BarChart({
  data,
  height = 220,
  color = "var(--mark-result)",
  negativeColor = "var(--delta-down)",
  format = shortMoney,
  label = "value",
}: {
  data: { label: string; value: number; sublabel?: string }[];
  height?: number;
  color?: string;
  negativeColor?: string;
  format?: (v: number) => string;
  label?: string;
}) {
  const [ref, width] = useMeasuredWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);

  if (data.length === 0) return <div className="empty">No data in this range.</div>;

  const pad = { top: 12, right: 14, bottom: 28, left: 52 };
  const plotW = Math.max(1, width - pad.left - pad.right);
  const plotH = Math.max(1, height - pad.top - pad.bottom);

  const hoverIndex = hover === null ? null : Math.min(hover, data.length - 1);
  const values = data.map((d) => d.value);
  const max = Math.max(...values, 0);
  const min = Math.min(...values, 0);
  const span = max - min || 1;

  // 2px of surface between neighbouring bars keeps them from reading as one mass.
  const slot = plotW / data.length;
  const barW = Math.max(2, slot - 2);

  const yAt = (v: number) => pad.top + plotH - ((v - min) / span) * plotH;
  const zeroY = yAt(0);
  const ticks = niceTicks(min, max, 4);

  return (
    <div className="chart-holder" ref={ref}>
      <svg className="chart" width={width} height={height} role="img" aria-label={label}>
        {ticks.map((tick) => (
          <g key={tick}>
            <line
              className="grid-line"
              x1={pad.left}
              x2={width - pad.right}
              y1={yAt(tick)}
              y2={yAt(tick)}
            />
            <text x={pad.left - 8} y={yAt(tick) + 3} textAnchor="end">
              {format(tick)}
            </text>
          </g>
        ))}

        <line
          className="axis-line"
          x1={pad.left}
          x2={width - pad.right}
          y1={zeroY}
          y2={zeroY}
        />

        {data.map((d, i) => {
          const x = pad.left + i * slot + 1;
          const positive = d.value >= 0;
          const y = positive ? yAt(d.value) : zeroY;
          const h = Math.abs(yAt(d.value) - zeroY);

          return (
            <path
              key={i}
              className={positive ? "bar-up" : "bar-down"}
              style={{ animationDelay: `${Math.min(i * 12, 500)}ms` }}
              d={positive ? barPath(x, y, barW, h) : barPathDown(x, y, barW, h)}
              fill={positive ? color : negativeColor}
              opacity={hover === null || hover === i ? 1 : 0.45}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
            />
          );
        })}

        {data.map((d, i) =>
          i % Math.ceil(data.length / 8) === 0 ? (
            <text
              key={`l-${i}`}
              x={pad.left + i * slot + barW / 2}
              y={height - 8}
              textAnchor="middle"
            >
              {d.label}
            </text>
          ) : null,
        )}
      </svg>

      <Tooltip
        width={width}
        state={
          hoverIndex !== null && data[hoverIndex]
            ? {
                x: pad.left + hoverIndex * slot + barW / 2,
                y: Math.min(yAt(data[hoverIndex]!.value), zeroY) - 4,
                title: data[hoverIndex]!.sublabel ?? data[hoverIndex]!.label,
                rows: [{ label, value: format(data[hoverIndex]!.value) }],
              }
            : null
        }
      />
    </div>
  );
}

/* --------------------------------------------------------- profit bridge */

export interface BridgeStep {
  label: string;
  /** Signed: revenue positive, costs negative. */
  value: Cents;
  kind: "start" | "cost" | "total";
}

/**
 * Waterfall from revenue down to profit.
 *
 * This is the single most useful chart in the product: it answers "where did
 * the money go" in one glance, which is exactly the question a merchant cannot
 * answer from Shopify alone.
 */
export function ProfitBridge({
  steps,
  height = 260,
}: {
  steps: BridgeStep[];
  height?: number;
}) {
  const [ref, width] = useMeasuredWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const gradId = useId().replace(/[^a-zA-Z0-9_-]/g, "");

  if (steps.length === 0) return <div className="empty">No data in this range.</div>;

  const pad = { top: 16, right: 14, bottom: 46, left: 56 };
  const plotW = Math.max(1, width - pad.left - pad.right);
  const plotH = Math.max(1, height - pad.top - pad.bottom);

  // Running position of each floating bar.
  let running = 0;
  const bars = steps.map((step) => {
    if (step.kind === "start") {
      running = step.value;
      return { step, from: 0, to: step.value };
    }
    if (step.kind === "total") {
      return { step, from: 0, to: step.value };
    }
    const from = running;
    running += step.value;
    return { step, from, to: running };
  });

  const max = Math.max(...bars.flatMap((b) => [b.from, b.to]), 0);
  const min = Math.min(...bars.flatMap((b) => [b.from, b.to]), 0);
  const span = max - min || 1;

  const yAt = (v: number) => pad.top + plotH - ((v - min) / span) * plotH;
  const slot = plotW / bars.length;
  const barW = Math.max(6, slot - 14);
  const ticks = niceTicks(min, max, 4);

  /*
   * Semantic, not categorical.
   *
   * Revenue is the structure you start with, costs are subtractions, and the
   * result is the only thing lit. Painting seven cost bars in alarm-red made
   * an ordinary P&L look like a system failure and buried the one number the
   * merchant came for.
   */
  const colorFor = (kind: BridgeStep["kind"]) =>
    kind === "cost"
      ? "var(--mark-cost)"
      : kind === "total"
        ? "var(--mark-result)"
        : "var(--mark-structure)";

  return (
    <div className="chart-holder" ref={ref}>
      <svg
        className="chart"
        width={width}
        height={height}
        role="img"
        aria-label="Revenue to profit bridge"
      >
        {ticks.map((tick) => (
          <g key={tick}>
            <line
              className="grid-line"
              x1={pad.left}
              x2={width - pad.right}
              y1={yAt(tick)}
              y2={yAt(tick)}
            />
            <text x={pad.left - 8} y={yAt(tick) + 3} textAnchor="end">
              {shortMoney(tick)}
            </text>
          </g>
        ))}

        <line
          className="axis-line"
          x1={pad.left}
          x2={width - pad.right}
          y1={yAt(0)}
          y2={yAt(0)}
        />

        <defs>
          <linearGradient id={`wf-struct-${gradId}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--mark-structure)" stopOpacity={0.85} />
            <stop offset="100%" stopColor="var(--mark-structure)" stopOpacity={0.85} />
          </linearGradient>
          <linearGradient id={`wf-cost-${gradId}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--mark-cost)" stopOpacity={0.6} />
            <stop offset="100%" stopColor="var(--mark-cost)" stopOpacity={0.6} />
          </linearGradient>
          <linearGradient id={`wf-result-${gradId}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity={1} />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity={1} />
          </linearGradient>
        </defs>

        {bars.map((bar, i) => {
          const top = Math.min(yAt(bar.from), yAt(bar.to));
          const h = Math.max(2, Math.abs(yAt(bar.to) - yAt(bar.from)));
          const x = pad.left + i * slot + (slot - barW) / 2;

          return (
            <g key={bar.step.label}>
              {i > 0 && (
                <line
                  x1={pad.left + (i - 1) * slot + (slot + barW) / 2}
                  x2={x}
                  y1={yAt(bars[i - 1]!.to)}
                  y2={yAt(bars[i - 1]!.to)}
                  // Solid, not dashed: a dashed rule reads as a projection
                  // or a threshold, and this is only a connector.
                  stroke="var(--rule)"
                  strokeWidth={1}
                />
              )}
              <path
                className={bar.to >= bar.from ? "bar-up" : "bar-down"}
                style={{
                  animationDelay: `${i * 70}ms`,
                  // only the result glows — costs stay matte so the eye lands
                  // on what is left rather than on what was spent
                  // No bloom: the result bar is already the only warm
                  // mark in the chart, and a glow reads as a different design
                  // language beside hairline rules.
                }}
                d={
                  bar.to >= bar.from
                    ? barPath(x, top, barW, h)
                    : barPathDown(x, top, barW, h)
                }
                fill={
                  bar.step.kind === "cost"
                    ? `url(#wf-cost-${gradId})`
                    : bar.step.kind === "total"
                      ? `url(#wf-result-${gradId})`
                      : `url(#wf-struct-${gradId})`
                }
                opacity={hover === null || hover === i ? 1 : 0.45}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
              />
              <text
                x={x + barW / 2}
                y={height - 28}
                textAnchor="middle"
                className="bridge-label"
              >
                {bar.step.label}
              </text>
              <text
                x={x + barW / 2}
                y={height - 13}
                textAnchor="middle"
                className="bridge-value"
                style={
                  bar.step.kind === "total"
                    ? { fill: "var(--mark-result)", fontWeight: 650 }
                    : undefined
                }
              >
                {shortMoney(bar.step.value)}
              </text>
            </g>
          );
        })}
      </svg>

      <Tooltip
        width={width}
        state={
          hover !== null
            ? {
                x: pad.left + hover * slot + slot / 2,
                y: Math.min(yAt(bars[hover]!.from), yAt(bars[hover]!.to)) - 4,
                title: bars[hover]!.step.label,
                rows: [
                  {
                    label: bars[hover]!.step.kind === "cost" ? "Cost" : "Amount",
                    value: formatMoney(bars[hover]!.step.value),
                  },
                  ...(bars[hover]!.step.kind === "cost"
                    ? [
                        {
                          label: "Running total",
                          value: formatMoney(bars[hover]!.to),
                        },
                      ]
                    : []),
                ],
              }
            : null
        }
      />
    </div>
  );
}

/* ------------------------------------------------------- horizontal bars */

export function HorizontalBars({
  data,
  format = (v: number) => formatMoney(v),
  maxRows = 12,
}: {
  data: { label: string; value: number; color?: string; sublabel?: string }[];
  format?: (v: number) => string;
  maxRows?: number;
}) {
  const rows = data.slice(0, maxRows);
  if (rows.length === 0) return <div className="empty">Nothing to show.</div>;

  const extent = Math.max(...rows.map((r) => Math.abs(r.value)), 1);
  const hasNegative = rows.some((r) => r.value < 0);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
      {rows.map((row) => {
        const pct = (Math.abs(row.value) / extent) * (hasNegative ? 50 : 100);
        const negative = row.value < 0;
        const color =
          row.color ?? (negative ? "var(--delta-down)" : "var(--mark-result)");

        return (
          <div key={row.label}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 12,
                marginBottom: 4,
              }}
            >
              <span style={{ fontSize: 12.5, minWidth: 0 }}>
                {row.label}
                {row.sublabel && <span className="cell-sub"> {row.sublabel}</span>}
              </span>
              <span className="num" style={{ fontSize: 12.5, fontWeight: 600 }}>
                {format(row.value)}
              </span>
            </div>
            <div
              style={{
                height: 6,
                background: "var(--rule)",
                borderRadius: 0,
                position: "relative",
                overflow: "hidden",
                boxShadow: "inset 0 1px 0 var(--glass-edge)",
              }}
            >
              <div
                className="hb-fill"
                style={{
                  position: "absolute",
                  left: hasNegative ? (negative ? `${50 - pct}%` : "50%") : 0,
                  width: `${pct}%`,
                  top: 0,
                  bottom: 0,
                  // gradient + glow so the bar carries the same energy as the
                  // rest of the surface rather than reading as a hairline
                  background: color,
                  borderRadius: 0,
                  animationDelay: `${Math.min(rows.indexOf(row) * 40, 600)}ms`,
                  transformOrigin: negative ? "right center" : "left center",
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ---------------------------------------------------------------- sparkline */

export function Sparkline({
  values,
  color = "var(--series-1)",
  width = 84,
  height = 24,
}: {
  values: number[];
  color?: string;
  width?: number;
  height?: number;
}) {
  if (values.length < 2) return null;

  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;

  const points = values.map((v, i) => ({
    x: (i / (values.length - 1)) * width,
    y: height - ((v - min) / span) * (height - 4) - 2,
  }));

  const last = points[points.length - 1];
  // The extreme, marked. Tufte's sparkline convention: the line carries shape,
  // one marked point carries position, and nothing else competes.
  const peakIndex = values.indexOf(max);
  const peak = points[peakIndex];

  return (
    <svg width={width} height={height} className="chart" aria-hidden="true">
      {/* A hairline at the series' own minimum gives the shape something to be
          read against; without it a sparkline is a squiggle at an unknown
          altitude. */}
      <line
        x1={0}
        x2={width}
        y1={height - 2}
        y2={height - 2}
        stroke="var(--rule)"
        strokeWidth={1}
      />
      <path
        className="draw"
        pathLength={1}
        d={linePath(points)}
        fill="none"
        stroke={color}
        strokeWidth={1.25}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {peak && peakIndex !== values.length - 1 && (
        <circle cx={peak.x} cy={peak.y} r={1.75} fill={color} opacity={0.5} />
      )}
      {last && (
        <circle
          cx={last.x}
          cy={last.y}
          r={2.75}
          fill={color}
          // A 2px surface ring rather than a stroke around the mark, so the
          // dot separates from the line without gaining a border.
          stroke="var(--plane)"
          strokeWidth={2}
        />
      )}
    </svg>
  );
}

/* ----------------------------------------------------------- capacity area */

export function CapacityChart({
  history,
  forecast,
  capacity,
  height = 250,
}: {
  history: { date: Date; received: number; fulfilled: number; backlog: number }[];
  forecast: { date: Date; inbound: number; backlog: number }[];
  capacity: number;
  height?: number;
}) {
  const [ref, width] = useMeasuredWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);

  const combined = [
    ...history.map((h) => ({
      date: h.date,
      inbound: h.received,
      backlog: h.backlog,
      projected: false,
    })),
    ...forecast.map((f) => ({
      date: f.date,
      inbound: f.inbound,
      backlog: f.backlog,
      projected: true,
    })),
  ];

  if (combined.length === 0) return <div className="empty">No fulfilment data yet.</div>;

  const pad = { top: 14, right: 14, bottom: 26, left: 46 };
  const plotW = Math.max(1, width - pad.left - pad.right);
  const plotH = Math.max(1, height - pad.top - pad.bottom);

  const max = Math.max(
    ...combined.map((c) => Math.max(c.inbound, c.backlog)),
    capacity,
  );

  const xAt = (i: number) =>
    pad.left +
    (combined.length === 1 ? plotW / 2 : (i / (combined.length - 1)) * plotW);
  const yAt = (v: number) => pad.top + plotH - (v / (max || 1)) * plotH;

  const firstForecast = history.length;
  const ticks = niceTicks(0, max, 4);
  const hoverIndex =
    hover === null ? null : Math.min(hover, combined.length - 1);

  const onMove = (event: React.MouseEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const index = Math.round(
      ((event.clientX - rect.left - pad.left) / plotW) * (combined.length - 1),
    );
    setHover(Math.max(0, Math.min(combined.length - 1, index)));
  };

  return (
    <div className="chart-holder" ref={ref}>
      <svg
        className="chart"
        width={width}
        height={height}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        role="img"
        aria-label="Orders received and backlog against warehouse capacity"
      >
        {ticks.map((tick) => (
          <g key={tick}>
            <line
              className="grid-line"
              x1={pad.left}
              x2={width - pad.right}
              y1={yAt(tick)}
              y2={yAt(tick)}
            />
            <text x={pad.left - 8} y={yAt(tick) + 3} textAnchor="end">
              {Math.round(tick)}
            </text>
          </g>
        ))}

        {/* the ceiling the warehouse cannot exceed */}
        <line
          x1={pad.left}
          x2={width - pad.right}
          y1={yAt(capacity)}
          y2={yAt(capacity)}
          stroke="var(--status-warning)"
          strokeWidth={1.5}
          strokeDasharray="5 4"
        />
        {/*
          * Pulled in from the boundary and lifted off its own rule. Sat flush
          * at `width - pad.right` the last glyph met the plot's edge, and six
          * pixels of clearance was not enough to keep a 1.5px dashed line out
          * of the type. The knockout does the rest — this label always crosses
          * the very rule it names.
          */}
        <text
          className="chart-rule-label"
          x={width - pad.right - 4}
          y={yAt(capacity) - 9}
          textAnchor="end"
          style={{ fill: "var(--status-warning)", fontWeight: 650 }}
        >
          CAPACITY {Math.round(capacity)}/DAY
        </text>

        {/*
          * The projected half.
          *
          * A faint grey box was the only thing separating measurement from
          * forecast, which asks the reader to remember that the right-hand
          * third of every line is a guess. Now the boundary is a labelled rule
          * and the projected span of each line is dashed — dashing is exactly
          * right here, where the anti-pattern is dashing something that is not
          * a projection.
          */}
        {firstForecast < combined.length && (
          <>
            <rect
              x={xAt(firstForecast)}
              y={pad.top}
              width={width - pad.right - xAt(firstForecast)}
              height={plotH}
              fill="var(--ink-muted)"
              opacity={0.045}
            />
            <line
              x1={xAt(firstForecast)}
              x2={xAt(firstForecast)}
              y1={pad.top}
              y2={pad.top + plotH}
              stroke="var(--rule-strong)"
              strokeWidth={1}
            />
            <text
              x={xAt(firstForecast) + 6}
              y={pad.top + 9}
              textAnchor="start"
              className="forecast-label"
            >
              projected
            </text>
          </>
        )}

        {/* Measured backlog, solid to the forecast boundary. */}
        <path
          className="draw"
          pathLength={1}
          d={linePath(
            combined
              .slice(0, firstForecast)
              .map((c, i) => ({ x: xAt(i), y: yAt(c.backlog) })),
          )}
          fill="none"
          stroke="var(--delta-down)"
          strokeWidth={1.6}
          strokeLinejoin="round"
        />
        {/* Projected backlog, dashed. Starts one point early so the two halves
            join rather than leaving a gap at the boundary. */}
        {firstForecast > 0 && firstForecast < combined.length && (
          <path
            d={linePath(
              combined
                .slice(firstForecast - 1)
                .map((c, i) => ({ x: xAt(firstForecast - 1 + i), y: yAt(c.backlog) })),
            )}
            fill="none"
            stroke="var(--delta-down)"
            strokeWidth={1.6}
            strokeDasharray="4 4"
            strokeLinejoin="round"
            opacity={0.85}
          />
        )}
        <path
          className="draw"
          pathLength={1}
          d={linePath(
            combined
              .slice(0, firstForecast)
              .map((c, i) => ({ x: xAt(i), y: yAt(c.inbound) })),
          )}
          fill="none"
          stroke="var(--mark-structure)"
          strokeWidth={1.6}
          strokeLinejoin="round"
        />
        {firstForecast > 0 && firstForecast < combined.length && (
          <path
            d={linePath(
              combined
                .slice(firstForecast - 1)
                .map((c, i) => ({ x: xAt(firstForecast - 1 + i), y: yAt(c.inbound) })),
            )}
            fill="none"
            stroke="var(--mark-structure)"
            strokeWidth={1.6}
            strokeDasharray="4 4"
            strokeLinejoin="round"
            opacity={0.85}
          />
        )}

        {hoverIndex !== null && (
          <line
            className="crosshair"
            x1={xAt(hoverIndex)}
            x2={xAt(hoverIndex)}
            y1={pad.top}
            y2={pad.top + plotH}
          />
        )}

        {combined.map((c, i) =>
          i % Math.ceil(combined.length / 7) === 0 ? (
            <text key={i} x={xAt(i)} y={height - 8} textAnchor="middle">
              {c.date.toLocaleDateString("en-US", {
                // CapacityDay.date is a calendar key encoded at UTC midnight,
                // not an instant to reinterpret in the viewer's zone.
                timeZone: "UTC",
                month: "short",
                day: "numeric",
              })}
            </text>
          ) : null,
        )}
      </svg>

      <Tooltip
        width={width}
        state={
          hover !== null
            ? {
                x: xAt(hover),
                y: pad.top + 6,
                title: `${combined[hover]!.date.toLocaleDateString("en-US", {
                  timeZone: "UTC",
                  month: "short",
                  day: "numeric",
                })}${combined[hover]!.projected ? " · projected" : ""}`,
                rows: [
                  {
                    label: "Orders in",
                    value: String(Math.round(combined[hover]!.inbound)),
                    color: "var(--series-1)",
                  },
                  {
                    label: "Backlog",
                    value: String(Math.round(combined[hover]!.backlog)),
                    color: "var(--series-2)",
                  },
                ],
              }
            : null
        }
      />
    </div>
  );
}

/* --------------------------------------------------------------- payback */

/**
 * Cumulative value per acquired customer against the cost of acquiring them.
 *
 * The crossing point is the whole story: where the line clears the CAC marker
 * is the day the channel starts making money. Checkpoints the cohort has not
 * aged into are omitted rather than drawn at zero.
 */
export function PaybackChart({
  series,
  cacCents,
  height = 230,
}: {
  series: {
    label: string;
    color: string;
    points: { day: number; valueCents: Cents; measurable: boolean }[];
  }[];
  cacCents: Cents | null;
  height?: number;
}) {
  const [ref, width] = useMeasuredWidth<HTMLDivElement>();
  const [hover, setHover] = useState<{ series: number; index: number } | null>(null);

  const visible = series.map((s) => ({
    ...s,
    points: s.points.filter((p) => p.measurable),
  }));

  if (visible.every((s) => s.points.length === 0)) {
    return <div className="empty">Not enough customer history yet.</div>;
  }

  // Right gutter carries the cohort labels rather than clipping them.
  const pad = { top: 14, right: 104, bottom: 28, left: 54 };
  const plotW = Math.max(1, width - pad.left - pad.right);
  const plotH = Math.max(1, height - pad.top - pad.bottom);

  const maxDay = Math.max(...visible.flatMap((s) => s.points.map((p) => p.day)), 1);
  const maxValue = Math.max(
    ...visible.flatMap((s) => s.points.map((p) => p.valueCents)),
    cacCents ?? 0,
    1,
  );

  const xAt = (day: number) => pad.left + (day / maxDay) * plotW;
  const yAt = (v: number) => pad.top + plotH - (v / maxValue) * plotH;
  const ticks = niceTicks(0, maxValue, 4);

  return (
    <div className="chart-holder" ref={ref}>
      <svg
        className="chart"
        width={width}
        height={height}
        role="img"
        aria-label="Cumulative value per acquired customer against acquisition cost"
      >
        {ticks.map((tick) => (
          <g key={tick}>
            <line
              className="grid-line"
              x1={pad.left}
              x2={width - pad.right}
              y1={yAt(tick)}
              y2={yAt(tick)}
            />
            <text x={pad.left - 8} y={yAt(tick) + 3} textAnchor="end">
              {shortMoney(tick)}
            </text>
          </g>
        ))}

        {cacCents !== null && cacCents > 0 && (
          <>
            <line
              x1={pad.left}
              x2={width - pad.right}
              y1={yAt(cacCents)}
              y2={yAt(cacCents)}
              stroke="var(--status-critical)"
              strokeWidth={1.5}
              strokeDasharray="5 4"
            />
            <text
              x={pad.left + 4}
              y={yAt(cacCents) - 6}
              textAnchor="start"
              style={{ fill: "var(--status-critical)", fontWeight: 650 }}
            >
              CAC {formatMoney(cacCents, "USD", { decimals: false })} — BREAK EVEN
            </text>
          </>
        )}

        {visible.map((s, si) => (
          <g key={s.label}>
            <path
              className="draw"
              pathLength={1}
              d={linePath(
                s.points.map((p) => ({ x: xAt(p.day), y: yAt(p.valueCents) })),
              )}
              fill="none"
              stroke={s.color}
              strokeWidth={1.6}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
            {s.points.map((p, pi) => (
              <circle
                key={p.day}
                className="dot-pop"
                style={{ animationDelay: `${200 + pi * 110}ms`, transition: "r 0.15s ease" }}
                cx={xAt(p.day)}
                cy={yAt(p.valueCents)}
                r={hover?.series === si && hover?.index === pi ? 6 : 4}
                fill={s.color}
                stroke="var(--plane)"
                strokeWidth={2}
                onMouseEnter={() => setHover({ series: si, index: pi })}
                onMouseLeave={() => setHover(null)}
              />
            ))}
          </g>
        ))}

        {/* Each cohort named where it ends: identity never depends on colour. */}
        {visible.length <= 4 &&
          visible.map((s) => {
            const end = s.points[s.points.length - 1];
            if (!end) return null;
            return (
              <text
                key={`lbl-${s.label}`}
                x={xAt(end.day) + 8}
                y={yAt(end.valueCents) + 3}
                textAnchor="start"
                className="series-end-label"
                style={{ fill: s.color }}
              >
                {s.label}
              </text>
            );
          })}

        {[0, 30, 60, 90].map((day) =>
          day <= maxDay ? (
            <text key={day} x={xAt(day)} y={height - 8} textAnchor="middle">
              DAY {day}
            </text>
          ) : null,
        )}
      </svg>

      <Tooltip
        width={width}
        state={
          hover
            ? (() => {
                const s = visible[hover.series];
                const point = s?.points[hover.index];
                if (!s || !point) return null;
                return {
                  x: xAt(point.day),
                  y: yAt(point.valueCents) - 4,
                  title: `Day ${point.day}`,
                  rows: [
                    {
                      label: s.label,
                      value: formatMoney(point.valueCents),
                      color: s.color,
                    },
                  ],
                };
              })()
            : null
        }
      />
    </div>
  );
}

/* ------------------------------------------------------------- theme toggle */

export function ThemeToggle() {
  const [theme, setTheme] = useState<"dark" | "light">("dark");

  useEffect(() => {
    const stored = window.localStorage.getItem("meridian-theme");
    if (stored === "light" || stored === "dark") {
      setTheme(stored);
      document.documentElement.dataset.theme = stored;
    }
  }, []);

  const toggle = useCallback(() => {
    // Briefly enable colour transitions so the whole surface cross-fades
    // instead of snapping between skies.
    const root = document.documentElement;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!reduced) {
      root.classList.add("theming");
      window.setTimeout(() => root.classList.remove("theming"), 420);
    }

    setTheme((current) => {
      const next = current === "dark" ? "light" : "dark";
      root.dataset.theme = next;
      window.localStorage.setItem("meridian-theme", next);

      // Keep the browser/OS chrome on the same ground as the page.
      document.querySelectorAll('meta[name="theme-color"]').forEach((tag) => {
        tag.setAttribute("content", next === "light" ? "#ffffff" : "#0a0a0a");
        tag.removeAttribute("media");
      });

      return next;
    });
  }, []);

  /*
   * The same switch the marketing site uses.
   *
   * It was a text glyph in a button — "☾" or "☀" — which renders in whatever
   * emoji or symbol face the OS happens to pick, so it was the one control in
   * the app that looked like a different product on every machine. This is
   * drawn: a track in the page's ink, a thumb in the page's ground, and one
   * icon at a time showing the mode you are in.
   */
  return (
    <button
      className="theme-switch"
      type="button"
      onClick={toggle}
      aria-label="Switch between light and dark"
      aria-pressed={theme === "dark"}
    >
      <span className="theme-switch-track" aria-hidden="true">
        <span className="theme-switch-thumb">
          <svg className="theme-icon theme-icon-sun" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <circle cx="10" cy="10" r="3.4" stroke="currentColor" strokeWidth="1.6" />
            <g stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              <path d="M10 2.6v2M10 15.4v2M2.6 10h2M15.4 10h2M4.8 4.8l1.4 1.4M13.8 13.8l1.4 1.4M15.2 4.8l-1.4 1.4M6.2 13.8l-1.4 1.4" />
            </g>
          </svg>
          <svg className="theme-icon theme-icon-moon" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path
              d="M16 12.4A6.8 6.8 0 0 1 7.6 4a6.8 6.8 0 1 0 8.4 8.4Z"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      </span>
    </button>
  );
}

export function ChartFrame({
  children,
  legend,
}: {
  children: ReactNode;
  legend?: ReactNode;
}) {
  return (
    <>
      {legend}
      {children}
    </>
  );
}

/*
 * The order field.
 *
 * One mark per order in the range, losses picked out. This began life on the
 * marketing page, arguing that a losing order is invisible on a sales report —
 * which was a strange place for it to live and nowhere else, because the
 * merchant who believes the argument then has no way to act on it. Here the
 * field is a control: point at a mark to read the order, click it to open the
 * receipt.
 *
 * Canvas rather than 3,000 DOM nodes. The field is redrawn on hover, on
 * resize, and when the theme changes — CSS cannot recolour a bitmap, so the
 * ink is read back out of the computed style each paint.
 */
export function OrderField({
  numbers,
  profits,
  focused,
  onPick,
}: {
  numbers: readonly number[];
  profits: readonly number[];
  focused: number | null;
  onPick: (orderNumber: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [geometry, setGeometry] = useState({ cols: 1, rows: 1, cell: 1 });

  const total = numbers.length;
  const losses = useMemo(
    () => profits.reduce((n, cents) => (cents < 0 ? n + 1 : n), 0),
    [profits],
  );

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || total === 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const cssWidth = canvas.clientWidth || 640;
    // A constant 3:2 field: the cell shrinks with the column rather than the
    // shape changing, so the mass reads the same at any width.
    const rows = Math.max(6, Math.round(Math.sqrt(total / 1.5)));
    const cols = Math.ceil(total / rows);
    const cell = cssWidth / cols;
    const cssHeight = rows * cell;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);
    canvas.style.height = `${cssHeight.toFixed(2)}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    const styles = getComputedStyle(document.documentElement);
    const ink = styles.getPropertyValue("--ink-rgb").trim() || "245, 245, 245";
    const radius = Math.max(1, cell * 0.26);

    // Kept orders: one path, one fill. Three thousand fillStyle writes is the
    // difference between painting in a frame and dropping them.
    ctx.fillStyle = `rgba(${ink}, 0.22)`;
    ctx.beginPath();
    for (let i = 0; i < total; i++) {
      if ((profits[i] ?? 0) < 0) continue;
      const x = ((i % cols) + 0.5) * cell;
      const y = (Math.floor(i / cols) + 0.5) * cell;
      ctx.moveTo(x + radius, y);
      ctx.arc(x, y, radius, 0, Math.PI * 2);
    }
    ctx.fill();

    // Losses at full ink and the same radius. Enlarging them is the obvious
    // move and the one this cannot make: area is the quantity the eye totals,
    // so a bigger dot would overstate how many there are.
    ctx.fillStyle = `rgba(${ink}, 1)`;
    ctx.beginPath();
    for (let i = 0; i < total; i++) {
      if ((profits[i] ?? 0) >= 0) continue;
      const x = ((i % cols) + 0.5) * cell;
      const y = (Math.floor(i / cols) + 0.5) * cell;
      ctx.moveTo(x + radius, y);
      ctx.arc(x, y, radius, 0, Math.PI * 2);
    }
    ctx.fill();

    const ring = (index: number, alpha: number, r: number) => {
      const x = ((index % cols) + 0.5) * cell;
      const y = (Math.floor(index / cols) + 0.5) * cell;
      ctx.strokeStyle = `rgba(${ink}, ${alpha})`;
      ctx.lineWidth = Math.max(1, cell * 0.13);
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.stroke();
    };

    const focusedIndex = focused === null ? -1 : numbers.indexOf(focused);
    if (focusedIndex >= 0) ring(focusedIndex, 0.95, radius * 2.2);
    if (hover !== null && hover !== focusedIndex) ring(hover, 0.55, radius * 1.9);

    setGeometry({ cols, rows, cell });
  }, [numbers, profits, total, focused, hover]);

  useEffect(() => {
    draw();
  }, [draw]);

  useEffect(() => {
    const onResize = () => draw();
    window.addEventListener("resize", onResize, { passive: true });
    return () => window.removeEventListener("resize", onResize);
  }, [draw]);

  const indexAt = (clientX: number, clientY: number): number | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const box = canvas.getBoundingClientRect();
    const { cols, rows, cell } = geometry;
    const x = ((clientX - box.left) / box.width) * (cols * cell);
    const y = ((clientY - box.top) / box.height) * (rows * cell);
    const col = Math.floor(x / cell);
    const row = Math.floor(y / cell);
    if (col < 0 || col >= cols || row < 0 || row >= rows) return null;
    const index = row * cols + col;
    if (index < 0 || index >= total) return null;
    // Only inside the mark itself, not the whitespace around it.
    const cx = (col + 0.5) * cell;
    const cy = (row + 0.5) * cell;
    const reach = Math.max(cell * 0.45, 5);
    if ((x - cx) ** 2 + (y - cy) ** 2 > reach ** 2) return null;
    return index;
  };

  const hoveredProfit = hover === null ? null : (profits[hover] ?? null);

  return (
    <div className="order-field">
      <div className="order-field-plot">
        <canvas
          ref={canvasRef}
          className="order-field-canvas"
          role="img"
          aria-label={`A field of ${total.toLocaleString()} marks, one per order in the range, with ${losses.toLocaleString()} marked as losing money.`}
          onPointerMove={(event) => {
            const next = indexAt(event.clientX, event.clientY);
            if (next !== hover) setHover(next);
          }}
          onPointerLeave={() => setHover(null)}
          onClick={(event) => {
            const index = indexAt(event.clientX, event.clientY);
            const picked = index === null ? undefined : numbers[index];
            if (picked !== undefined) onPick(picked);
          }}
        />
        {hover !== null && (
          <div className="order-field-readout" aria-hidden="true">
            Order #{numbers[hover]} ·{" "}
            {hoveredProfit !== null && hoveredProfit < 0
              ? "lost money"
              : "profitable"}
          </div>
        )}
      </div>
      <p className="order-field-key">
        <span>
          <i className="key-kept" /> {(total - losses).toLocaleString()} profitable
        </span>
        <span>
          <i className="key-loss" /> {losses.toLocaleString()} losing money
        </span>
        <span className="order-field-hint">Point at any order; click to open it.</span>
      </p>
    </div>
  );
}
