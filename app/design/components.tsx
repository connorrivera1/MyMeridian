import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import { formatMoney, formatPercent, type Cents } from "~/engine/money";
import { APP_NAME } from "~/lib/brand";

/* ------------------------------------------------------------- brand mark */

/** Globe geometry, in viewBox units. */
const GLOBE_R = 34;

/**
 * A meridian's resting half-width, and the longitude that produces it.
 *
 * A longitude line on a sphere projects to an ellipse of half-width
 * R·cos(longitude), so the logo's resting widths tell us exactly where each
 * meridian sits. Spinning the globe is then just advancing every longitude by
 * the same angle and re-projecting — which is what actually reads as rotation.
 * Rotating the flat SVG in 3D instead makes it collapse to a line edge-on and
 * flip inside out.
 */
const MERIDIANS = [
  { restRx: 24.5, track: "meridian-a" },
  { restRx: 13.5, track: "meridian-b" },
  { restRx: 0, track: "meridian-c" },
];

const LIT_REST_RX = 15;

/**
 * The Meridian mark: a wireframe globe of longitude lines with one meridian
 * lit, matching the logotype.
 *
 * `orbit` adds a slow dashed ring outside the globe, for the auth hero only.
 * `spin` plays one rotation on mount, used by the opening sequence.
 */
export function BrandMark({
  size = 28,
  orbit = false,
  spin = false,
}: {
  size?: number;
  orbit?: boolean;
  /** Play one full rotation on mount, settling back into the logo. */
  spin?: boolean;
}) {
  // useId can contain characters that are awkward inside url(#…); keep the
  // fragment strictly [A-Za-z0-9_-] so the reference always resolves.
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");

  return (
    <svg
      className={spin ? "mark spinning" : "mark"}
      width={size}
      height={size}
      viewBox="0 0 96 96"
      fill="none"
      aria-hidden="true"
    >
      <defs>
        <filter id={`glow-${id}`} x="-80%" y="-80%" width="260%" height="260%">
          <feGaussianBlur stdDeviation="2.6" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {orbit && (
        <circle
          className="orbit-ring"
          cx="48"
          cy="48"
          r="43"
          stroke="currentColor"
          strokeWidth="1"
          strokeDasharray="4 10"
          opacity="0.28"
        />
      )}

      {/* The wireframe globe. Rendered at its resting geometry, so if the
          animation never runs — no JS, reduced motion, a throttled tab — it is
          still exactly the logo rather than a half-finished frame. */}
      <g
        stroke="currentColor"
        strokeWidth="2"
        opacity="0.8"
        strokeLinecap="round"
      >
        <circle cx="48" cy="48" r={GLOBE_R} />
        {MERIDIANS.map((m) => (
          <ellipse
            key={m.track}
            className={m.track}
            cx="48"
            cy="48"
            rx={m.restRx}
            ry={GLOBE_R}
          />
        ))}
        <path d="M48 14v68" />
      </g>

      {/* The lit prime meridian holds still while the globe turns behind it —
          fitting for the thing the app is named after, and it keeps the brand
          element legible throughout the spin. */}
      <path
        className="glow-arc"
        d={`M48 14 A ${LIT_REST_RX} ${GLOBE_R} 0 0 1 48 82`}
        stroke="var(--accent)"
        strokeWidth="2.5"
        strokeLinecap="round"
        filter={`url(#glow-${id})`}
      />
    </svg>
  );
}

/* --------------------------------------------------------- animated money */

/**
 * Count-up for headline figures.
 *
 * SSR renders the final value, so the page is correct without JavaScript and
 * search/screenshots never catch a zero. On mount the number sweeps up from
 * zero; when the value changes later (a range switch), it eases from the old
 * figure to the new one instead of restarting. Reduced motion gets the final
 * value immediately.
 */
export function useCountUp(target: number, duration = 750): number {
  const [display, setDisplay] = useState(target);
  const previous = useRef<number | null>(null);

  useEffect(() => {
    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const from = previous.current ?? 0;
    previous.current = target;

    if (reduced || from === target) {
      setDisplay(target);
      return;
    }

    let raf = 0;
    const startedAt = performance.now();

    const tick = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / duration);
      const eased = 1 - (1 - progress) ** 3;
      setDisplay(Math.round(from + (target - from) * eased));
      if (progress < 1) raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);

  return display;
}

/** Money that counts up. Same formatting contract as <Money>. */
export function AnimatedMoney({
  cents,
  currency = "USD",
  compact = false,
  decimals = true,
}: {
  cents: Cents;
  currency?: string;
  compact?: boolean;
  decimals?: boolean;
}) {
  const display = useCountUp(cents);
  return (
    <span className={cents < 0 ? "money neg num" : "money num"}>
      {formatMoney(display, currency, { compact, decimals })}
    </span>
  );
}

/** A plain integer that counts up — order counts, backlog sizes. */
export function AnimatedInt({ value }: { value: number }) {
  const display = useCountUp(value);
  return <span className="num">{display.toLocaleString()}</span>;
}

/* --------------------------------------------------------------- splash */

/**
 * Total sequence length; must stay in step with the CSS delays.
 *
 * The last letter of a ten-letter wordmark starts at 0.682s and takes 0.3s, so
 * the word completes at ~0.98s. 1320ms leaves the same ~334ms of finished
 * wordmark on screen that the eight-letter "Meridian" had at 1240ms — the pause
 * after the word lands is what the sequence reads as, so it is held constant
 * rather than absorbed by the rename.
 */
const SPLASH_MS = 1320;
const SPLASH_FADE_MS = 260;

/**
 * Plays once per document load, not per client-side navigation.
 *
 * A module-level flag rather than state, so moving between dashboard pages
 * never replays it. It starts false on both server and client, which keeps the
 * first render identical on each side and avoids a hydration mismatch.
 */
let splashPlayed = false;

export function Splash() {
  const [done, setDone] = useState(splashPlayed);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (splashPlayed) return;

    // Reduced motion still sees the mark, just briefly and without movement.
    const reduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const hold = reduced ? 420 : SPLASH_MS;

    const toFade = window.setTimeout(() => setLeaving(true), hold);
    const toEnd = window.setTimeout(() => {
      splashPlayed = true;
      setDone(true);
    }, hold + SPLASH_FADE_MS);

    return () => {
      window.clearTimeout(toFade);
      window.clearTimeout(toEnd);
    };
  }, []);

  if (done) return null;

  return (
    <div
      className={leaving ? "splash out" : "splash"}
      role="status"
      aria-label={APP_NAME}
    >
      <div className="splash-inner">
        <div className="splash-globe">
          <BrandMark size={112} spin />
        </div>
        <div className="splash-word" aria-hidden="true">
          {APP_NAME.split("").map((letter, i) => (
            <span key={`${letter}-${i}`}>{letter}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- KPI tiles */

/**
 * A full-bleed sparkline that fills the bottom of a tile.
 *
 * Drawn as a gradient area under a saturated stroke rather than a hairline —
 * at tile size a thin grey line reads as decoration, whereas a lit one gives
 * the number a shape at a glance.
 */
function TileSpark({
  values,
  tone,
  height = 46,
}: {
  values: number[];
  tone: string;
  height?: number;
}) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  if (values.length < 2) return <div style={{ height }} />;

  const width = 300;
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 0);
  const span = max - min || 1;
  const pad = 5;

  const pts = values.map((v, i) => ({
    x: (i / (values.length - 1)) * width,
    y: height - pad - ((v - min) / span) * (height - pad * 2),
  }));

  const line = pts
    .map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`)
    .join(" ");

  return (
    <svg
      className="spark"
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      height={height}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={`sp-${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={tone} stopOpacity={0.42} />
          <stop offset="100%" stopColor={tone} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path
        className="area-fade"
        d={`${line} L${width},${height} L0,${height} Z`}
        fill={`url(#sp-${id})`}
      />
      <path
        className="draw"
        pathLength={1}
        d={line}
        fill="none"
        stroke={tone}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/**
 * The primary KPI surface.
 *
 * Every tile owns a hue via the `--tile` custom property, which the icon chip,
 * top rule, hover glow and sparkline all inherit. That is what stops a row of
 * KPIs reading as identical grey rectangles.
 */
export function Tile({
  label,
  value,
  meta,
  tone = "var(--viz-blue)",
  icon,
  spark,
  hero = false,
}: {
  label: ReactNode;
  value: ReactNode;
  meta?: ReactNode;
  tone?: string;
  icon?: ReactNode;
  spark?: number[];
  hero?: boolean;
}) {
  return (
    <div
      className={hero ? "tile hero" : "tile"}
      style={{ ["--tile" as string]: tone }}
    >
      <div className="tile-head">
        {icon && <span className="tile-icon">{icon}</span>}
        <span className="tile-label">{label}</span>
      </div>
      <div className="tile-value">{value}</div>
      <div className="tile-meta">{meta}</div>
      {/* A tile with no trend collapses to a small foot rather than reserving
          the sparkline's height, which would leave it looking bottom-heavy
          beside its neighbours. An all-zero series counts as no trend — a lit
          line hugging the floor reads as data when it is only a baseline. */}
      {spark && spark.length > 1 && spark.some((v) => v !== 0) ? (
        <div className="tile-spark">
          <TileSpark values={spark} tone={tone} height={hero ? 74 : 46} />
        </div>
      ) : (
        <div style={{ height: hero ? 20 : 16 }} />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ icons */

type IconProps = { className?: string };

const svg = (path: ReactNode, extra?: Record<string, unknown>) =>
  function Icon({ className }: IconProps) {
    return (
      <svg
        className={className}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        {...extra}
      >
        {path}
      </svg>
    );
  };

export const IconOverview = svg(
  <>
    <rect x="3" y="3" width="7" height="9" rx="1.5" />
    <rect x="14" y="3" width="7" height="5" rx="1.5" />
    <rect x="14" y="12" width="7" height="9" rx="1.5" />
    <rect x="3" y="16" width="7" height="5" rx="1.5" />
  </>,
);

export const IconOrders = svg(
  <>
    <path d="M3 6h18l-1.5 12.5a2 2 0 0 1-2 1.5H6.5a2 2 0 0 1-2-1.5Z" />
    <path d="M8.5 6V4.5a3.5 3.5 0 0 1 7 0V6" />
  </>,
);

export const IconProducts = svg(
  <>
    <path d="M21 8.5 12 3 3 8.5v7L12 21l9-5.5Z" />
    <path d="M3 8.5 12 14l9-5.5M12 14v7" />
  </>,
);

/** Stacked boxes with a ledger rule: components rolling up to one cost. */
export const IconCosts = svg(
  <>
    <rect x="3" y="13" width="7" height="8" rx="1.5" />
    <rect x="14" y="13" width="7" height="8" rx="1.5" />
    <path d="M12 3v6M12 9l-4.5 4M12 9l4.5 4" />
  </>,
);

export const IconChannels = svg(
  <>
    <path d="M4 20V10M10 20V4M16 20v-7M22 20v-11" />
  </>,
);

export const IconPricing = svg(
  <>
    <path d="M20.5 13.5 13 21a2 2 0 0 1-2.8 0l-7-7A2 2 0 0 1 2.6 12V5a2 2 0 0 1 2-2h7a2 2 0 0 1 1.4.6l7.5 7.5a2 2 0 0 1 0 2.4Z" />
    <circle cx="7.5" cy="7.5" r="1.3" />
  </>,
);

export const IconFulfilment = svg(
  <>
    <path d="M2 8h11v9H2zM13 11h4.5l3.5 3.5V17h-8z" />
    <circle cx="6" cy="18.5" r="1.8" />
    <circle cx="17" cy="18.5" r="1.8" />
  </>,
);

export const IconSettings = svg(
  <>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1v.3a2 2 0 1 1-4 0v-.2a1.6 1.6 0 0 0-2.8-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 3.5 15H3a2 2 0 1 1 0-4h.2A1.6 1.6 0 0 0 4.3 8.2l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 9.8 4.3V4a2 2 0 1 1 4 0v.2a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7h.3a2 2 0 1 1 0 4h-.2a1.6 1.6 0 0 0-1.1 1.1Z" />
  </>,
);

export const IconPrivacy = svg(
  <>
    <path d="M12 2.5 20 6v5.5c0 4.7-3.2 8.3-8 10-4.8-1.7-8-5.3-8-10V6l8-3.5Z" />
    <path d="M9 11.5 11 13.5 15.5 9" />
  </>,
);

export const IconAlert = svg(
  <>
    <path d="M12 9v4.5M12 17h.01" />
    <path d="M10.3 3.9 2.6 17.4A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3.1L13.7 3.9a2 2 0 0 0-3.4 0Z" />
  </>,
);

/** Subscription plan — a card, matching the billing screen it links to. */
export const IconPlan = svg(
  <>
    <rect x="2.5" y="5" width="19" height="14" rx="2.5" />
    <path d="M2.5 10h19M6.5 14.5h4" />
  </>,
);

/**
 * Critical gets an octagon, warning keeps the triangle.
 *
 * Both severities previously rendered the same triangle and differed only by
 * colour, which is the one thing a severity must never rest on.
 */
export const IconCritical = svg(
  <>
    <path d="M8.6 3h6.8L20 7.6v6.8L15.4 19H8.6L4 14.4V7.6Z" />
    <path d="M12 8v4.5M12 16h.01" />
  </>,
);

export const IconInfo = svg(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5M12 8h.01" />
  </>,
);

export const IconCheck = svg(<path d="m4.5 12.5 5 5 10-11" />);

export const IconArrowUp = svg(<path d="M12 19V5M6 11l6-6 6 6" />);
export const IconArrowDown = svg(<path d="M12 5v14M18 13l-6 6-6-6" />);

/* -------------------------------------------------------------- primitives */

export function Card({
  title,
  hint,
  actions,
  children,
  flush,
  id,
}: {
  title?: ReactNode;
  hint?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  flush?: boolean;
  id?: string;
}) {
  return (
    <section className="card" id={id}>
      {(title || actions) && (
        <header className="card-head">
          <div style={{ minWidth: 0 }}>
            {title && <h2 className="card-title">{title}</h2>}
            {hint && <p className="card-hint">{hint}</p>}
          </div>
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      <div className={flush ? "card-body flush" : "card-body"}>{children}</div>
    </section>
  );
}

export function Money({
  cents,
  currency = "USD",
  compact = false,
  decimals = true,
  signed = false,
}: {
  cents: Cents;
  currency?: string;
  compact?: boolean;
  decimals?: boolean;
  signed?: boolean;
}) {
  const text = formatMoney(cents, currency, { compact, decimals });
  return (
    <span className={cents < 0 ? "money neg num" : "money num"}>
      {signed && cents > 0 ? `+${text}` : text}
    </span>
  );
}

/**
 * Change indicator.
 *
 * Always carries an arrow glyph as well as colour — a red number alone is not
 * readable to a merchant with deuteranopia, and this component appears beside
 * every headline figure in the product.
 */
export function Delta({
  value,
  invert = false,
  suffix,
}: {
  /** Fractional change, e.g. 0.12 for +12%. Null renders a flat dash. */
  value: number | null;
  /** Set when down is good — cost per acquisition, days to clear backlog. */
  invert?: boolean;
  suffix?: string;
}) {
  if (value === null || !Number.isFinite(value)) {
    return <span className="delta flat">—</span>;
  }

  const rounded = Math.abs(value) < 0.0005 ? 0 : value;
  if (rounded === 0) return <span className="delta flat">no change</span>;

  const rising = rounded > 0;
  const good = invert ? !rising : rising;

  return (
    <span className={`delta ${good ? "up" : "down"}`}>
      {rising ? (
        <IconArrowUp className="delta-icon" />
      ) : (
        <IconArrowDown className="delta-icon" />
      )}
      {/* The arrow glyph and the wash colour are the two visual channels, but
          both are invisible to a screen reader — the icons are aria-hidden and
          the figure is absolute-valued, so this announced a bare "12%" with no
          direction. */}
      <span className="sr-only">{rising ? "up " : "down "}</span>
      {formatPercent(Math.abs(rounded), Math.abs(rounded) >= 0.1 ? 0 : 1)}
      {suffix ? ` ${suffix}` : ""}
    </span>
  );
}

export function Stat({
  label,
  value,
  meta,
  hero = false,
  small = false,
  tooltip,
}: {
  label: ReactNode;
  value: ReactNode;
  meta?: ReactNode;
  hero?: boolean;
  small?: boolean;
  tooltip?: string;
}) {
  return (
    <div className={hero ? "stat stat-hero" : "stat"}>
      <div className="stat-label" title={tooltip}>
        {label}
        {tooltip && <IconInfo className="stat-info" />}
      </div>
      <div className={small ? "stat-value sm" : "stat-value"}>{value}</div>
      {meta && <div className="stat-meta">{meta}</div>}
    </div>
  );
}

export function StatCard(props: Parameters<typeof Stat>[0]) {
  return (
    <div className="card">
      <Stat {...props} />
    </div>
  );
}

export type BadgeTone = "good" | "warning" | "serious" | "critical" | "neutral";

export function Badge({
  tone,
  children,
  dot = false,
}: {
  tone: BadgeTone;
  children: ReactNode;
  dot?: boolean;
}) {
  return (
    <span className={`badge ${tone}`}>
      {dot && (
        <span className="badge-dot" style={{ background: "currentColor" }} />
      )}
      {children}
    </span>
  );
}

export function Alert({
  severity,
  title,
  children,
  daysUntil,
}: {
  severity: "CRITICAL" | "WARNING" | "INFO";
  title: ReactNode;
  children: ReactNode;
  daysUntil?: number | null;
}) {
  const tone =
    severity === "CRITICAL"
      ? "critical"
      : severity === "WARNING"
        ? "warning"
        : "info";
  const Icon =
    severity === "INFO"
      ? IconInfo
      : severity === "CRITICAL"
        ? IconCritical
        : IconAlert;

  return (
    <div className={`alert ${tone}`}>
      <Icon className="alert-icon" />
      <div style={{ minWidth: 0 }}>
        <h3 className="alert-title">
          {/* severity is carried by icon shape and this word, never by colour */}
          <span className="sr-only">{severity.toLowerCase()}: </span>
          {title}
          {typeof daysUntil === "number" && (
            <Badge tone={severity === "CRITICAL" ? "critical" : "warning"}>
              In {daysUntil} {daysUntil === 1 ? "day" : "days"}
            </Badge>
          )}
        </h3>
        <p className="alert-detail">{children}</p>
      </div>
    </div>
  );
}

export function Legend({
  items,
}: {
  items: { label: string; color: string }[];
}) {
  return (
    <div className="legend">
      {items.map((item) => (
        <span className="legend-item" key={item.label}>
          <span className="legend-swatch" style={{ background: item.color }} />
          {item.label}
        </span>
      ))}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Banner({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "warn";
  children: ReactNode;
}) {
  return (
    <div className={tone === "warn" ? "banner warn" : "banner"}>
      {tone === "warn" ? <IconAlert /> : <IconInfo />}
      <div>{children}</div>
    </div>
  );
}

/** Series colours, by slot. Order is the colourblind-safety mechanism. */
export const SERIES_VARS = [
  "var(--series-1)",
  "var(--series-2)",
  "var(--series-3)",
  "var(--series-4)",
  "var(--series-5)",
  "var(--series-6)",
  "var(--series-7)",
  "var(--series-8)",
] as const;

/**
 * Colour follows the entity, never its rank — a channel keeps its hue when the
 * list is filtered or re-sorted. Assignment is by a fixed key order, so
 * "Facebook is blue" stays true across every screen in the app.
 */
export function seriesColor(key: string, order: readonly string[]): string {
  const index = order.indexOf(key);
  if (index >= 0 && index < SERIES_VARS.length) return SERIES_VARS[index]!;
  return "var(--ink-muted)";
}

/* ------------------------------------------------------------ plan gating */

/**
 * Shown in place of a screen the current plan does not include.
 *
 * Deliberately says what the feature does and what it costs, rather than just
 * refusing — a merchant who cannot tell what they would be buying has no reason
 * to buy it. The button goes to the in-app plan picker, never straight out to
 * the Shopify admin.
 */
export function UpgradeNotice({
  feature,
  planName,
  price,
  children,
}: {
  /** What is locked, in the merchant's words: "Pricing recommendations". */
  feature: string;
  planName: string;
  price: number;
  /** One or two sentences on what the screen would show them. */
  children: ReactNode;
}) {
  return (
    <div className="card">
      <div style={{ padding: "26px 24px", maxWidth: "68ch" }}>
        <Badge tone="neutral">{planName} plan</Badge>
        <h2
          className="card-title"
          style={{ fontSize: 17, margin: "12px 0 8px" }}
        >
          {feature} is part of {planName}
        </h2>
        <p
          className="secondary"
          style={{ margin: "0 0 18px", lineHeight: 1.65 }}
        >
          {children}
        </p>
        <a className="btn primary" href="/app/plan">
          See plans — {planName} is ${price}/month
        </a>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- legal pages */

/**
 * Chrome for the public, unauthenticated documents Shopify's listing links to:
 * the privacy policy and the support page. Deliberately outside the app shell —
 * a reviewer opens these with no session and they must render on their own.
 */
export function LegalPage({
  title,
  updated,
  children,
}: {
  title: string;
  updated?: string;
  children: ReactNode;
}) {
  return (
    <main className="legal">
      <header className="legal-head">
        <a className="legal-brand" href="/">
          <BrandMark size={30} />
          <span>{APP_NAME}</span>
        </a>
        <h1>{title}</h1>
        {updated && <p className="legal-updated">Last updated {updated}</p>}
      </header>
      {children}
    </main>
  );
}

/**
 * Renders the support contact, or says plainly that it is missing.
 *
 * An unconfigured deployment showing a placeholder address would be worse than
 * showing nothing: Shopify's reviewer emails whatever is on the page, and a
 * bounce reads as an unsupported app.
 */
export function LegalContact({
  contact,
}: {
  contact: {
    supportEmail: string;
    supportUrl: string;
    legalEntity: string;
  };
}) {
  const { supportEmail, supportUrl, legalEntity } = contact;

  if (!supportEmail && !supportUrl) {
    return (
      <p className="legal-gap">
        Support contact is not configured on this deployment. Set{" "}
        <code>MERIDIAN_SUPPORT_EMAIL</code>, <code>MERIDIAN_LEGAL_ENTITY</code>{" "}
        and optionally <code>MERIDIAN_SUPPORT_URL</code> before submitting to
        the Shopify App Store — a reachable contact is a listing requirement.
      </p>
    );
  }

  return (
    <p>
      {legalEntity && <>{legalEntity}. </>}
      {supportEmail && (
        <>
          Email <a href={`mailto:${supportEmail}`}>{supportEmail}</a>.{" "}
        </>
      )}
      {supportUrl && (
        <>
          Support site:{" "}
          <a href={supportUrl} rel="noreferrer">
            {supportUrl}
          </a>
          .
        </>
      )}
    </p>
  );
}
