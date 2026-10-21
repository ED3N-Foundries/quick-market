const tails = new Map<string, Promise<unknown>>()

/** True while this process is still finishing a grant for the address. */
export function grantWaiting(address: string): boolean {
  return tails.has(address)
}

/** Run one grant after the previous one for this address. The waiter is set before `job` starts. */
export function trackGrant<T>(address: string, job: () => Promise<T>): Promise<T> {
  const previous = tails.get(address) ?? Promise.resolve()
  const run = previous.catch(() => undefined).then(job)
  tails.set(address, run)
  void run.finally(() => {
    if (tails.get(address) === run) tails.delete(address)
  }).catch(() => undefined)
  return run
}
