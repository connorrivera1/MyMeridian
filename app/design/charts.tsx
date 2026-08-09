import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
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

  const pad = { top: 12, right: 14, bottom: 26, left: 52 };
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
                stroke="var(--surface-1)"
                strokeWidth={2}
              />
            ))}
          </>
        )}

        {data.map((d, i) =>
          i % Math.ceil(data.length / 7) === 0 ? (
            <text key={i} x={xAt(i)} y={height - 8} textAnchor="middle">
              {d.date.toLocaleDateString("en-US", { month: "short", day: "numeric" })}
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

  const xAt = (i: number) => pad.left + (i / (combined.length - 1)) * plotW;
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
        <text
          x={width - pad.right}
          y={yAt(capacity) - 6}
          textAnchor="end"
          style={{ fill: "var(--status-warning)", fontWeight: 650 }}
        >
          capacity {Math.round(capacity)}/day
        </text>

        {/* forecast region */}
        {firstForecast < combined.length && (
          <rect
            x={xAt(firstForecast)}
            y={pad.top}
            width={width - pad.right - xAt(firstForecast)}
            height={plotH}
            fill="var(--ink-muted)"
            opacity={0.06}
          />
        )}

        <path
          className="draw"
          pathLength={1}
          d={linePath(combined.map((c, i) => ({ x: xAt(i), y: yAt(c.backlog) })))}
          fill="none"
          stroke="var(--delta-down)"
          strokeWidth={1.6}
          strokeLinejoin="round"
        />
        <path
          className="draw"
          pathLength={1}
          d={linePath(combined.map((c, i) => ({ x: xAt(i), y: yAt(c.inbound) })))}
          fill="none"
          stroke="var(--mark-structure)"
          strokeWidth={1.6}
          strokeLinejoin="round"
        />

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
              {c.date.toLocaleDateString("en-US", { month: "short", day: "numeric" })}
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

  const pad = { top: 14, right: 16, bottom: 28, left: 54 };
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
              x={width - pad.right}
              y={yAt(cacCents) - 5}
              textAnchor="end"
              style={{ fill: "var(--status-critical)", fontWeight: 600 }}
            >
              CAC {formatMoney(cacCents, "USD", { decimals: false })}
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
                stroke="var(--surface-1)"
                strokeWidth={2}
                onMouseEnter={() => setHover({ series: si, index: pi })}
                onMouseLeave={() => setHover(null)}
              />
            ))}
          </g>
        ))}

        {[0, 30, 60, 90].map((day) =>
          day <= maxDay ? (
            <text key={day} x={xAt(day)} y={height - 8} textAnchor="middle">
              day {day}
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

      // Keep the browser/OS chrome on the same sky as the page.
      document.querySelectorAll('meta[name="theme-color"]').forEach((tag) => {
        tag.setAttribute("content", next === "light" ? "#f4efe5" : "#161c36");
        tag.removeAttribute("media");
      });

      return next;
    });
  }, []);

  return (
    <button className="btn sm" onClick={toggle} aria-label="Toggle colour theme">
      {theme === "dark" ? "☾" : "☀"}
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
