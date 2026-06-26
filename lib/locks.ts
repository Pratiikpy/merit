/**
 * Per-key in-process serializer. On-chain writes from the SAME EOA must not be
 * in flight concurrently, or two runs read the same pending nonce and one tx is
 * dropped ("nonce too low"). Routing every buyer/operator write through
 * serialize("buyer" | "operator", ...) makes them sequential within the process.
 */
const chains = new Map<string, Promise<unknown>>();

export function serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn); // run regardless of the previous result
  chains.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}
