/** Same units, validation and default as python/weflow_backend/timeouts.py. */
export function liveTimeoutMs(value: string | undefined = process.env.WEFLOW_LIVE_TIMEOUT_MS): number {
  if (value === undefined) return 30_000
  if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > 2_147_481_647) {
    throw Object.assign(new Error('Live timeout must be an integer from 1 to 2147481647 milliseconds.'), { code: 'INVALID_ARGUMENT' })
  }
  return Number(value)
}
