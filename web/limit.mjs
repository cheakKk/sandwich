// A sliding-window rate limiter, shared by the control plane and the gateway. Old keys are pruned so rotating keys cannot grow it forever.
export function createLimiter() {
  const hits = new Map();
  return (key, max, windowMs) => {
    const t = Date.now(), h = (hits.get(key) ?? []).filter((x) => x > t - windowMs);
    h.push(t); hits.set(key, h);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((x) => x > t - windowMs)) hits.delete(k);
    return h.length > max;
  };
}
