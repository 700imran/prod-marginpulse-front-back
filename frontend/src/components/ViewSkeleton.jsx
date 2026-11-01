/**
 * ViewSkeleton — shimmering placeholder shown while a screen (or its data) loads.
 * It appears only if loading lasts longer than `delay` ms, so data that is already cached never flashes a skeleton;
 * until then it reserves the same space so the page doesn't jump. Variants mirror real screens.
 */
import { useEffect, useState } from "react";

export default function ViewSkeleton({ variant = "cards", delay = 60 }) {
  const [show, setShow] = useState(delay === 0);
  useEffect(() => {
    if (delay === 0) return undefined;
    const t = setTimeout(() => setShow(true), delay);
    return () => clearTimeout(t);
  }, [delay]);

  if (!show) return <div style={{ minHeight: 280 }} aria-hidden="true" />;

  return (
    <div className="view-skeleton" role="status" aria-busy="true" aria-label="Loading">
      <div className="skeleton sk-title" />
      {variant === "dashboard" && (
        <div className="sk-kpis">{[0, 1, 2, 3].map((i) => <div key={i} className="skeleton sk-kpi" />)}</div>
      )}
      {variant === "table" && (
        <div className="card">
          <div className="skeleton sk-line" style={{ width: "30%" }} />
          {[0, 1, 2, 3, 4, 5].map((i) => <div key={i} className="skeleton sk-line" style={{ width: `${96 - (i % 3) * 8}%` }} />)}
        </div>
      )}
      {variant === "form" && (
        <div className="card">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} style={{ marginBottom: 18 }}>
              <div className="skeleton sk-line" style={{ width: "22%" }} />
              <div className="skeleton sk-input" />
            </div>
          ))}
        </div>
      )}
      {(variant === "cards" || variant === "dashboard") && (
        <>
          <div className="skeleton sk-row" />
          <div className="skeleton sk-row" />
          <div className="skeleton sk-row short" />
        </>
      )}
    </div>
  );
}
