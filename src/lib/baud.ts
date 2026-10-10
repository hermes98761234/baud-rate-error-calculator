export type FamilyId = 'stm32' | 'stm32lp' | 'avr' | 'esp32' | 'rp2040' | 'generic'

export interface Options {
  /** STM32 USART: oversampling by 8 instead of 16. */
  over8: boolean
  /** AVR: double-speed mode (U2X). */
  u2x: boolean
  /** Generic: samples per bit (oversampling factor). */
  oversample: number
  /** Generic: fractional bits in the divider (0 = integer divider). */
  fracBits: number
}

export const DEFAULT_OPTIONS: Options = { over8: false, u2x: false, oversample: 16, fracBits: 0 }

export interface Result {
  ok: boolean
  /** Human readable divider, e.g. "UBRR = 103". */
  divider: string
  /** Register value(s) in hex, when meaningful. */
  reg: string
  /** Formula lines with numbers substituted. */
  steps: string[]
  actual: number
  /** Signed error in percent relative to the requested baud. */
  errorPct: number
  /** Reason for ok === false. */
  problem?: string
}

export interface Family {
  id: FamilyId
  name: string
  /** Typical clock presets (Hz) with labels. */
  presets: [string, number][]
}

export const FAMILIES: Family[] = [
  { id: 'stm32', name: 'STM32 USART (BRR)', presets: [['8 MHz (F1 HSI)', 8e6], ['16 MHz (HSI)', 16e6], ['36 MHz (F1 APB1)', 36e6], ['72 MHz (F1 APB2)', 72e6], ['84 MHz (F4 APB2)', 84e6], ['168 MHz', 168e6]] },
  { id: 'stm32lp', name: 'STM32 LPUART (BRR = 256·f/baud)', presets: [['32.768 kHz (LSE)', 32768], ['4 MHz (MSI)', 4e6], ['16 MHz (HSI)', 16e6], ['80 MHz', 80e6]] },
  { id: 'avr', name: 'AVR / Arduino (UBRR, U2X)', presets: [['1 MHz', 1e6], ['8 MHz', 8e6], ['16 MHz (Uno)', 16e6], ['20 MHz', 20e6], ['14.7456 MHz', 14.7456e6]] },
  { id: 'esp32', name: 'ESP32 (fractional divider)', presets: [['80 MHz (APB)', 80e6], ['40 MHz (XTAL)', 40e6], ['160 MHz (C3 PLL)', 160e6]] },
  { id: 'rp2040', name: 'RP2040 PL011 (IBRD + FBRD)', presets: [['125 MHz (clk_peri)', 125e6], ['48 MHz', 48e6], ['133 MHz', 133e6]] },
  { id: 'generic', name: 'Generic divider', presets: [['1.8432 MHz', 1.8432e6], ['3.6864 MHz', 3.6864e6], ['11.0592 MHz', 11.0592e6], ['24 MHz', 24e6]] },
]

export const STANDARD_BAUDS = [300, 600, 1200, 2400, 4800, 9600, 14400, 19200, 28800, 38400, 57600, 76800, 115200, 230400, 250000, 460800, 500000, 921600, 1000000, 1500000, 2000000, 3000000]

const fmt = (x: number, d = 4): string => (Number.isInteger(x) ? String(x) : x.toFixed(d).replace(/0+$/, '').replace(/\.$/, ''))
const hex = (n: number, w = 0): string => '0x' + n.toString(16).toUpperCase().padStart(w, '0')

function fail(problem: string): Result {
  return { ok: false, divider: '-', reg: '-', steps: [], actual: NaN, errorPct: NaN, problem }
}

function done(baud: number, actual: number, divider: string, reg: string, steps: string[]): Result {
  return { ok: true, divider, reg, steps, actual, errorPct: ((actual - baud) / baud) * 100 }
}

/** Computes the divider the hardware would use and the baud rate it really produces. */
export function calcBaud(family: FamilyId, clock: number, baud: number, o: Options = DEFAULT_OPTIONS): Result {
  if (!(clock > 0) || !(baud > 0)) return fail('Enter a positive clock and baud rate.')
  switch (family) {
    case 'stm32': {
      // USARTDIV = fck / (8 * (2 - OVER8) * baud); BRR holds it with 4 (OVER8=0) or 3 (OVER8=1) fraction bits.
      const os = o.over8 ? 8 : 16
      const n = Math.round(clock / baud) // = os * USARTDIV
      if (n < os) return fail('Baud rate is too high for this clock (needs USARTDIV ≥ 1).')
      if (n > os * 4095 + os - 1) return fail('Baud rate is too low: USARTDIV does not fit in 12 bits.')
      const mant = Math.floor(n / os)
      const frac = n % os
      const brr = (mant << 4) | frac
      const exact = clock / (os * baud)
      return done(baud, clock / n, `USARTDIV = ${mant} + ${frac}/${os}`, `BRR = ${hex(brr, 4)}`, [
        `USARTDIV = fck / (${os} × baud) = ${fmt(clock)} / (${os} × ${fmt(baud)}) = ${fmt(exact, 5)}`,
        `Fraction in 1/${os} steps: mantissa ${mant}, fraction ${frac}`,
        `actual baud = fck / (${os} × ${mant + frac / os}) = ${fmt(clock / n, 2)}`,
      ])
    }
    case 'stm32lp': {
      // LPUART: baud = 256 * fck / BRR, BRR is 20 bits and must be >= 0x300.
      const exact = (256 * clock) / baud
      const brr = Math.round(exact)
      if (brr < 0x300) return fail('Baud rate is too high: LPUART needs BRR ≥ 0x300 (fck ≥ 3 × baud).')
      if (brr > 0xfffff) return fail('Baud rate is too low: BRR does not fit in 20 bits.')
      return done(baud, (256 * clock) / brr, `BRR = ${brr}`, `BRR = ${hex(brr, 5)}`, [
        `BRR = 256 × fck / baud = 256 × ${fmt(clock)} / ${fmt(baud)} = ${fmt(exact, 3)}`,
        `rounded: BRR = ${brr}`,
        `actual baud = 256 × fck / BRR = ${fmt((256 * clock) / brr, 2)}`,
      ])
    }
    case 'avr': {
      const k = o.u2x ? 8 : 16
      const exact = clock / (k * baud) - 1
      const ubrr = Math.round(exact)
      if (ubrr < 0) return fail('Baud rate is too high for this clock.')
      if (ubrr > 4095) return fail('Baud rate is too low: UBRR does not fit in 12 bits.')
      const actual = clock / (k * (ubrr + 1))
      return done(baud, actual, `UBRR = ${ubrr}`, `UBRR = ${hex(ubrr, 3)}`, [
        `UBRR = fosc / (${k} × baud) − 1 = ${fmt(clock)} / (${k} × ${fmt(baud)}) − 1 = ${fmt(exact, 3)}`,
        `rounded: UBRR = ${ubrr}${o.u2x ? ' (U2X = 1)' : ''}`,
        `actual baud = fosc / (${k} × (UBRR + 1)) = ${fmt(actual, 2)}`,
      ])
    }
    case 'esp32': {
      // clk_div = clk / baud with a 4-bit fraction (CLKDIV = integer part, CLKDIV_FRAG = fraction in 1/16).
      const exact = clock / baud
      let int = Math.floor(exact)
      let frag = Math.round((exact - int) * 16)
      if (frag === 16) { int += 1; frag = 0 }
      if (int < 1) return fail('Baud rate is too high for this clock.')
      if (int > 0xfffff) return fail('Baud rate is too low: divider does not fit in 20 bits.')
      const div = int + frag / 16
      return done(baud, clock / div, `div = ${int} + ${frag}/16`, `CLKDIV = ${hex(int)}, FRAG = ${frag}`, [
        `div = clk / baud = ${fmt(clock)} / ${fmt(baud)} = ${fmt(exact, 5)}`,
        `integer ${int}, fraction round(${fmt(exact - Math.floor(exact), 4)} × 16) = ${frag}`,
        `actual baud = clk / (${int} + ${frag}/16) = ${fmt(clock / div, 2)}`,
      ])
    }
    case 'rp2040': {
      // PL011: BRD = UARTCLK / (16 * baud); IBRD integer, FBRD = round(frac * 64).
      const exact = clock / (16 * baud)
      let ibrd = Math.floor(exact)
      let fbrd = Math.round((exact - ibrd) * 64)
      if (fbrd === 64) { ibrd += 1; fbrd = 0 }
      if (ibrd < 1) return fail('Baud rate is too high for this clock (needs IBRD ≥ 1).')
      if (ibrd > 65535) return fail('Baud rate is too low: IBRD does not fit in 16 bits.')
      const div = ibrd + fbrd / 64
      return done(baud, clock / (16 * div), `IBRD = ${ibrd}, FBRD = ${fbrd}`, `IBRD = ${hex(ibrd, 4)}, FBRD = ${hex(fbrd, 2)}`, [
        `BRD = clk / (16 × baud) = ${fmt(clock)} / (16 × ${fmt(baud)}) = ${fmt(exact, 5)}`,
        `IBRD = ${ibrd}, FBRD = round(${fmt(exact - Math.floor(exact), 4)} × 64) = ${fbrd}`,
        `actual baud = clk / (16 × (${ibrd} + ${fbrd}/64)) = ${fmt(clock / (16 * div), 2)}`,
      ])
    }
    case 'generic': {
      const k = Math.max(1, Math.round(o.oversample))
      const f = Math.min(16, Math.max(0, Math.round(o.fracBits)))
      const exact = clock / (k * baud)
      const steps = 2 ** f
      const q = Math.round(exact * steps)
      if (q < steps) return fail('Baud rate is too high for this clock (divider < 1).')
      const div = q / steps
      return done(baud, clock / (k * div), f ? `div = ${fmt(div, 6)} (${q}/${steps})` : `div = ${q}`, f ? `div × 2^${f} = ${q}` : `div = ${hex(q)}`, [
        `div = fclk / (${k} × baud) = ${fmt(clock)} / (${k} × ${fmt(baud)}) = ${fmt(exact, 5)}`,
        f ? `quantised to 1/${steps}: ${fmt(div, 6)}` : `rounded: ${q}`,
        `actual baud = fclk / (${k} × ${fmt(div, 6)}) = ${fmt(clock / (k * div), 2)}`,
      ])
    }
  }
}

export type Grade = 'good' | 'ok' | 'marginal' | 'bad'

/** Rough grade for an error in percent (8N1 tolerates about ±4 % total on paper, ±2 % is the practical limit). */
export function gradeError(errPct: number, ppm = 0, limit = 2): Grade {
  const e = Math.abs(errPct) + ppm / 1e4
  if (!(e >= 0)) return 'bad'
  if (e <= limit / 2) return 'good'
  if (e <= limit) return 'ok'
  if (e <= limit * 1.5) return 'marginal'
  return 'bad'
}

export interface Row {
  baud: number
  result: Result
}

export function baudTable(family: FamilyId, clock: number, o: Options, bauds: number[] = STANDARD_BAUDS): Row[] {
  return bauds.map((baud) => ({ baud, result: calcBaud(family, clock, baud, o) }))
}

export const CRYSTALS_HZ = [
  1e6, 1.8432e6, 2e6, 2.4576e6, 3.6864e6, 4e6, 4.9152e6, 6e6, 7.3728e6, 8e6, 9.8304e6, 10e6, 11.0592e6, 12e6, 12.288e6, 14.7456e6, 16e6, 18.432e6, 19.6608e6, 20e6,
  22.1184e6, 24e6, 24.576e6, 25e6, 26e6, 27e6, 29.4912e6, 32e6, 40e6, 48e6, 50e6, 72e6, 80e6, 100e6,
]

export interface Suggestion {
  clock: number
  worstPct: number
  /** Per-baud error, same order as the requested bauds. */
  errors: number[]
}

/** Ranks standard crystals by worst-case |error| over the wanted bauds (lowest first, then lowest frequency). */
export function suggestCrystals(family: FamilyId, o: Options, bauds: number[], candidates: number[] = CRYSTALS_HZ, maxClock = Infinity): Suggestion[] {
  const out: Suggestion[] = []
  for (const clock of candidates) {
    if (clock > maxClock) continue
    const errors = bauds.map((b) => calcBaud(family, clock, b, o))
    if (errors.some((r) => !r.ok)) continue
    const e = errors.map((r) => r.errorPct)
    out.push({ clock, worstPct: Math.max(...e.map(Math.abs)), errors: e })
  }
  return out.sort((a, b) => a.worstPct - b.worstPct || a.clock - b.clock)
}

/** Highest standard baud whose error stays within the limit. */
export function maxGoodBaud(family: FamilyId, clock: number, o: Options, limitPct: number): number | null {
  let best: number | null = null
  for (const b of STANDARD_BAUDS) {
    const r = calcBaud(family, clock, b, o)
    if (r.ok && Math.abs(r.errorPct) <= limitPct) best = b
  }
  return best
}

export function parseBaudList(s: string): number[] {
  return s.split(/[\s,;]+/).map(Number).filter((n) => Number.isFinite(n) && n > 0)
}
