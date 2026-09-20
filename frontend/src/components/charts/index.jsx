/**
 * Reusable dashboard chart primitives, built on recharts.
 *
 * These are intentionally generic — they take plain {label, value}[]
 * data rather than assuming a single-tenant dashboard shape, so the
 * same components can be dropped into a future multi-client/portfolio
 * dashboard or an SME summary view without rework. See BRAIN.md's
 * "Frontend visual/perf pass" section for where this is headed next.
 */
import {
  PieChart, Pie, Cell, ResponsiveContainer, Tooltip, Legend,
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
} from "recharts";

const PALETTE = ["#18c496", "#f59e0b", "#ef4444", "#6366f1", "#94a3b8", "#0f6e56"];

/**
 * StatusDonut — a small donut chart for a status breakdown (e.g.
 * matched / needs action / GST gaps). `data` is [{ label, value }].
 * Renders nothing if every value is zero, so an empty/new account
 * doesn't show a confusing all-grey ring.
 */
export function StatusDonut({ data, height = 220 }) {
  const total = data.reduce((sum, d) => sum + (d.value || 0), 0);
  if (total === 0) {
    return (
      <div style={{ height, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-gray)", fontSize: 13 }}>
        No documents yet — upload one to see this chart fill in.
      </div>
    );
  }
  return (
    <ResponsiveContainer width="100%" height={height}>
      <PieChart>
        <Pie data={data} dataKey="value" nameKey="label" innerRadius="55%" outerRadius="80%" paddingAngle={2}>
          {data.map((_, i) => (
            <Cell key={i} fill={PALETTE[i % PALETTE.length]} />
          ))}
        </Pie>
        <Tooltip formatter={(v) => v.toLocaleString("en-IN")} />
        <Legend verticalAlign="bottom" height={28} iconType="circle" wrapperStyle={{ fontSize: 12 }} />
      </PieChart>
    </ResponsiveContainer>
  );
}

/**
 * RiskBarChart — horizontal bar chart ranking items by a ₹ value
 * (e.g. vendors by tax-at-risk). `data` is [{ label, value }],
 * pre-sorted by the caller (highest risk first is typical).
 */
export function RiskBarChart({ data, height = 240, valueFormatter }) {
  if (!data || data.length === 0) {
    return (
      <div style={{ height, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-gray)", fontSize: 13 }}>
        Nothing to show yet.
      </div>
    );
  }
  const fmt = valueFormatter || ((v) => v.toLocaleString("en-IN"));
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} layout="vertical" margin={{ left: 8, right: 16, top: 4, bottom: 4 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" horizontal={false} />
        <XAxis type="number" tick={{ fontSize: 11, fill: "var(--text-gray)" }} tickFormatter={fmt} />
        <YAxis type="category" dataKey="label" width={110} tick={{ fontSize: 12, fill: "var(--text-dark)" }} />
        <Tooltip formatter={(v) => fmt(v)} />
        <Bar dataKey="value" fill="#18c496" radius={[0, 6, 6, 0]} maxBarSize={22} />
      </BarChart>
    </ResponsiveContainer>
  );
}
