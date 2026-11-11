import { Layers } from "lucide-react";
import { CartesianGrid, Line, LineChart, Tooltip, XAxis, YAxis } from "recharts";
import { ChartBox, ChartTip, Legend, axis, grid } from "@/components/chart";
import { Badge } from "@/components/ui/badge";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { LiveChannels } from "../../../src/live_core.ts";
import { clock, fmt } from "@/lib/utils";

const SPAN = 10 * 60_000;
const COLORS: string[] = ["var(--chart-6)", "var(--chart-1)", "var(--chart-6)", "var(--chart-2)", "var(--chart-3)", "var(--chart-5)", "var(--chart-5)"];

type Role = "ambient" | "green (PW1)" | "LED" | "—";

/** The optical colour assignments apply to the observed first-generation Pixel layouts. */
function roles(c: LiveChannels): Role[] {
  const last = c.history[c.history.length - 1];
  const out: Role[] = [];
  for (let i = 0; i < c.width; i++) {
    if (last.dc[i] == null) { out.push("—"); continue; }
    if (c.led[i] === 0 || last.pi[i] == null) { out.push("ambient"); continue; }
    out.push("LED");
  }
  // green = last channel of the full configs (v6 in night mode, v5 in day mode, confirmed by the nights);
  // the strongest pulse is not reliable (v4 beat v6 on 2026-11-06). Off the wrist (1–2 LEDs) there is no green.
  const g = c.width === 7 ? 6 : c.width === 6 ? 5 : -1;
  if (g >= 0 && out[g] === "LED") out[g] = "green (PW1)";
  return out;
}

function Spark({ y, color }: { y: (number | null)[]; color: string }) {
  if (!y.length) return <div className="h-10" />;
  const v = y.filter((x): x is number => x != null);
  const lo = Math.min(...v), hi = Math.max(...v), r = hi - lo || 1;
  const pts = y.map((x, i) => (x == null ? null : `${(i / (y.length - 1)) * 100},${38 - ((x - lo) / r) * 36}`)).filter(Boolean).join(" ");
  return (
    <svg viewBox="0 0 100 40" preserveAspectRatio="none" className="h-10 w-full">
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.2} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/**
 * All PPG channels: LED mode (6/7 values), LED current, DC and pulse strength per channel, the last 8 s of each
 * channel and 10 min of DC/PI history. Meant for the colour-paper and finger tests.
 */
export function ChannelsCard({ c }: { c: LiveChannels }) {
  const h = c.history, last = h[h.length - 1], end = last.t;
  const rl = roles(c);
  const col = (i: number): string => (rl[i] === "green (PW1)" ? "var(--chart-4)" : COLORS[i % COLORS.length]);
  const led = rl.map((r, i) => (r === "LED" || r === "green (PW1)" ? i : -1)).filter((i) => i >= 0);
  const recent = h.filter((p) => p.t >= end - SPAN);
  // DC relative to the first point in view (colour test: which channel drops on which paper)
  const base = led.map((i) => recent.find((p) => p.dc[i] != null && p.dc[i]! > 0)?.dc[i] ?? null);
  const rows = recent.map((p) => {
    const o: Record<string, number | null> = { t: p.t };
    led.forEach((i, k) => {
      o[`dc${i}`] = p.dc[i] != null && base[k] ? Math.round((p.dc[i]! / base[k]!) * 1000) / 10 : null;
      o[`pi${i}`] = p.pi[i];
    });
    return o;
  });
  const night = c.width === 7;
  const mode = night ? "PW1 night layout" : c.width === 6 ? "PW1 day layout" : "unmapped layout";
  const xAxis = <XAxis {...axis} dataKey="t" type="number" domain={[end - SPAN, end]} allowDataOverflow tickFormatter={(v: number) => clock(v).slice(0, 5)} />;
  const legend = led.map((i) => ({ label: `v${i}`, color: col(i), line: true }));
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Layers className="size-4 text-muted-foreground" />PPG channels</CardTitle>
        <CardDescription>All raw channels, every 2 s over 8 s. PI = pulse strength in % of DC. Ambient = LED off.</CardDescription>
        <CardAction className="flex flex-wrap gap-1.5">
          <Badge variant={night ? "default" : "warning"}>{c.width} channels · {mode}</Badge>
          {c.modes.length > 1 && <Badge variant="outline">last switch {clock(c.modes[c.modes.length - 1][0])}</Badge>}
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
          {rl.map((r, i) => (
            <div key={i} className={`rounded-md border p-2 ${r === "ambient" || r === "—" ? "opacity-60" : ""}`}>
              <div className="flex items-baseline justify-between">
                <span className="font-mono text-sm font-semibold">v{i}</span>
                <span className="text-xs text-muted-foreground">{r}</span>
              </div>
              <div className="text-xs text-muted-foreground">{c.led[i] != null ? `${fmt(c.led[i], 2)} mA` : "LED ?"}</div>
              <div className="font-mono text-xs tabular-nums">DC {last.dc[i] == null ? "–" : last.dc[i]!.toLocaleString("en-US")}</div>
              <div className="font-mono text-lg tabular-nums">{last.pi[i] == null ? "–" : `${fmt(last.pi[i], 3)} %`}</div>
              <Spark y={c.trace.y[i] ?? []} color={col(i)} />
            </div>
          ))}
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <div>
            <div className="mb-1 flex items-center justify-between"><span className="text-sm font-medium">DC, % of first value (10 min)</span><Legend items={legend} /></div>
            <ChartBox className="h-48">
              <LineChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid {...grid} />
                {xAxis}
                <YAxis {...axis} type="number" domain={["auto", "auto"]} width={40} />
                <Tooltip content={({ payload }) => payload?.length ? (
                  <ChartTip title={clock(Number(payload[0].payload?.t))} rows={payload.map((p) => ({ label: String(p.name), value: `${fmt(Number(p.value), 2)} %`, color: String(p.color) }))} />) : null} />
                {led.map((i) => <Line key={i} dataKey={`dc${i}`} name={`v${i}`} type="linear" stroke={col(i)} strokeWidth={1.5} dot={false} isAnimationActive={false} />)}
              </LineChart>
            </ChartBox>
          </div>
          <div>
            <div className="mb-1 flex items-center justify-between"><span className="text-sm font-medium">Pulse strength PI % (10 min, log)</span><Legend items={legend} /></div>
            <ChartBox className="h-48">
              <LineChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid {...grid} />
                {xAxis}
                <YAxis {...axis} type="number" scale="log" domain={["auto", "auto"]} allowDataOverflow width={40} tickFormatter={(v: number) => fmt(v, 2)} />
                <Tooltip content={({ payload }) => payload?.length ? (
                  <ChartTip title={clock(Number(payload[0].payload?.t))} rows={payload.map((p) => ({ label: String(p.name), value: `${fmt(Number(p.value), 2)} %`, color: String(p.color) }))} />) : null} />
                {led.map((i) => <Line key={i} dataKey={`pi${i}`} name={`v${i}`} type="linear" stroke={col(i)} strokeWidth={1.5} dot={false} isAnimationActive={false} />)}
              </LineChart>
            </ChartBox>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Colour test: watch off the wrist, sensor down on white, red and green paper in the dark, 30 s each. The red LED's DC
          stays high on red paper and drops on green; infrared stays high on both. Finger test: finger on the sensor, PI rises
          several-fold. LED currents appear once the watch app streams the PPG controller (or in replay).
        </p>
      </CardContent>
    </Card>
  );
}
