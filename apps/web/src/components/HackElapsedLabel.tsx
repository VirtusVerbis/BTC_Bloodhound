import { useEffect, useState } from "react";
import { formatHackElapsed } from "../lib/hackElapsed";

export function HackElapsedLabel() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const iv = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(iv);
  }, []);

  const label = formatHackElapsed(now);

  return (
    <span className="hack-elapsed-label" aria-label={label}>
      {label}
    </span>
  );
}
