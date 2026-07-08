import { useEffect, useState } from 'react';

export default function DeferredRecharts({ height = 180, children }) {
  const [charts, setCharts] = useState(null);

  useEffect(() => {
    let active = true;
    import('recharts')
      .then((module) => {
        if (active) setCharts(module);
      })
      .catch(() => {
        if (active) setCharts(false);
      });
    return () => {
      active = false;
    };
  }, []);

  if (!charts) {
    return (
      <div
        aria-hidden="true"
        className="grid w-full place-items-center rounded-xl bg-secondary/40"
        style={{ height }}
      >
        <div className="h-2 w-16 max-w-[70%] rounded-full bg-muted" />
      </div>
    );
  }

  return children(charts);
}
