"use client";
import { useId, useState } from "react";
import { Button } from "@chilli/ui";

/**
 * Small dependency-free SVG charts on design-system tokens (no chart library). Rules from the dataviz guidance:
 * one axis, thin marks with a 2px surface gap, identity never colour-alone (legend + per-mark text + table view),
 * text in text tokens, hover/focus shows the exact value, series colours follow the entity (series index is fixed).
 */
export interface Series { name: string }
export interface Row { label: string; values: number[] }

const W = 560, H = 220, PAD = { l: 36, r: 8, t: 8, b: 26 };

function niceMax(v: number) { if (v <= 4) return 4; const p = 10 ** Math.floor(Math.log10(v)); return Math.ceil(v / p) * p; }

/** Vertical stacked bars (one stack per label). With one series it is a plain bar chart and shows no legend. */
export function StackedBars({ title, series, rows, unit = "" }: { title: string; series: Series[]; rows: Row[]; unit?: string }) {
  const [tip, setTip] = useState("");
  const [asTable, setAsTable] = useState(false);
  const id = useId();
  const totals = rows.map((r) => r.values.reduce((a, b) => a + b, 0));
  const max = niceMax(Math.max(0, ...totals));
  const iw = W - PAD.l - PAD.r, ih = H - PAD.t - PAD.b;
  const bw = rows.length ? Math.min(48, (iw / rows.length) * 0.6) : 0, step = rows.length ? iw / rows.length : 0;
  const y = (v: number) => PAD.t + ih - (v / max) * ih;
  const ticks = [0, max / 2, max];
  return (
    <figure className="hq-chart" aria-labelledby={`${id}-t`}>
      <figcaption id={`${id}-t`}>{title}</figcaption>
      {asTable ? <DataTable series={series} rows={rows} /> : (
        <>
        {/* Phones: one row per period with a horizontal stacked bar and the total written out (an SVG scaled to 330px is unreadable). */}
        <ul className="hq-hstack" aria-label={title}>
          {rows.map((r, i) => (
            <li key={r.label}>
              <span className="hq-hstack__l">{r.label}</span>
              <span className="hq-hstack__bar" aria-hidden="true">
                {r.values.map((v, k) => (v > 0 ? <i key={k} className={`hq-s${k}`} style={{ width: `${(v / max) * 100}%` }} title={`${series[k].name} ${v}${unit}`} /> : null))}
              </span>
              <span className="hq-hstack__v">{totals[i]}{unit}<span className="ch-sr-only">{series.length > 1 ? `: ${r.values.map((v, k) => `${series[k].name} ${v}`).join(", ")}` : ""}</span></span>
            </li>
          ))}
        </ul>
        <svg className="hq-vbars" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title}. ${rows.map((r, i) => `${r.label}: ${totals[i]}`).join(", ")}`}>
          {ticks.map((t) => <g key={t}><line className="hq-grid-line" x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} /><text x={PAD.l - 6} y={y(t) + 4} textAnchor="end">{t}</text></g>)}
          <line className="hq-axis" x1={PAD.l} x2={W - PAD.r} y1={y(0)} y2={y(0)} />
          {rows.map((r, i) => {
            let acc = 0;
            const x = PAD.l + step * i + (step - bw) / 2;
            return (
              <g key={r.label}>
                {r.values.map((v, k) => {
                  if (v <= 0) return null;
                  const top = y(acc + v), h = y(acc) - top; acc += v;
                  const msg = `${r.label}: ${series[k].name} ${v}${unit}${series.length > 1 ? `, total ${totals[i]}${unit}` : ""}`;
                  return <rect key={k} className={`hq-bar hq-s${k}`} x={x} y={top} width={bw} height={Math.max(h, 1)} rx={3} tabIndex={0} aria-label={msg}
                    onMouseEnter={() => setTip(msg)} onFocus={() => setTip(msg)} onMouseLeave={() => setTip("")} onBlur={() => setTip("")}><title>{msg}</title></rect>;
                })}
                {totals[i] > 0 ? <text x={x + bw / 2} y={y(totals[i]) - 4} textAnchor="middle">{totals[i]}</text> : null}
                <text x={x + bw / 2} y={H - 8} textAnchor="middle">{r.label}</text>
              </g>
            );
          })}
        </svg>
        </>
      )}
      <p className="hq-chart-tip" aria-live="polite">{asTable ? "" : tip}</p>
      {series.length > 1 ? <ul className="hq-legend" aria-label="Legend">{series.map((s, k) => <li key={s.name}><i className={`hq-s${k}`} aria-hidden="true" />{s.name}</li>)}</ul> : null}
      <Button size="sm" onClick={() => setAsTable(!asTable)}>{asTable ? "Show chart" : "Show as table"}</Button>
    </figure>
  );
}

function DataTable({ series, rows }: { series: Series[]; rows: Row[] }) {
  return (
    <table className="hq-mono" style={{ width: "100%", borderCollapse: "collapse" }}>
      <thead><tr><th scope="col" align="left">Period</th>{series.map((s) => <th scope="col" align="right" key={s.name}>{s.name}</th>)}{series.length > 1 ? <th scope="col" align="right">Total</th> : null}</tr></thead>
      <tbody>{rows.map((r) => <tr key={r.label}><th scope="row" align="left">{r.label}</th>{r.values.map((v, k) => <td align="right" key={k}>{v}</td>)}{series.length > 1 ? <td align="right">{r.values.reduce((a, b) => a + b, 0)}</td> : null}</tr>)}</tbody>
    </table>
  );
}

/** Horizontal single-hue bars with the value written after each bar. HTML (not SVG) so labels stay legible at phone width. */
export function HBars({ title, rows, format }: { title: string; rows: { label: string; value: number }[]; format: (n: number) => string }) {
  const id = useId();
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <figure className="hq-chart" aria-labelledby={`${id}-t`}>
      <figcaption id={`${id}-t`}>{title}</figcaption>
      <ul className="hq-hbars">
        {rows.map((r) => (
          <li key={r.label}>
            <span className="hq-hbars__l">{r.label}</span>
            <span className="hq-hbars__bar" aria-hidden="true"><i className="hq-s0" style={{ width: `${Math.max(1, (r.value / max) * 100)}%` }} /></span>
            <span className="hq-hbars__v">{format(r.value)}</span>
          </li>
        ))}
      </ul>
    </figure>
  );
}
