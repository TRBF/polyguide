import { useEffect, useState } from 'react';
import { API, type HealthResponse } from '@polyguide/shared';

export function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  useEffect(() => {
    fetch(API.health)
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => setHealth(null));
  }, []);
  return (
    <main>
      <h1>PolyGuide</h1>
      <p>Server: {health ? (health.mock ? 'mock' : 'live') : 'unreachable'}</p>
    </main>
  );
}
