import { describe, expect, it } from 'vitest'
import { baudTable, calcBaud, gradeError, maxGoodBaud, parseBaudList, suggestCrystals, DEFAULT_OPTIONS as D } from './baud'

describe('AVR', () => {
  it('16 MHz, 9600: UBRR 103, +0.16 %', () => {
    const r = calcBaud('avr', 16e6, 9600, D)
    expect(r.divider).toBe('UBRR = 103')
    expect(r.actual).toBeCloseTo(9615.38, 2)
    expect(r.errorPct).toBeCloseTo(0.16, 2)
  })
  it('16 MHz, 115200: UBRR 8 gives -3.55 %, U2X gives UBRR 16 and +2.12 %', () => {
    const a = calcBaud('avr', 16e6, 115200, D)
    expect(a.divider).toBe('UBRR = 8')
    expect(a.errorPct).toBeCloseTo(-3.55, 2)
    const b = calcBaud('avr', 16e6, 115200, { ...D, u2x: true })
    expect(b.divider).toBe('UBRR = 16')
    expect(b.errorPct).toBeCloseTo(2.12, 2)
  })
  it('14.7456 MHz is exact for the standard rates', () => {
    for (const b of [9600, 19200, 38400, 57600, 115200]) expect(calcBaud('avr', 14.7456e6, b, D).errorPct).toBeCloseTo(0, 9)
  })
  it('rejects impossible rates', () => {
    expect(calcBaud('avr', 1e6, 1e6, D).ok).toBe(false)
    expect(calcBaud('avr', 16e6, 0, D).ok).toBe(false)
  })
})

describe('STM32 USART', () => {
  it('72 MHz, 115200: USARTDIV 39.0625, BRR 0x0271, exact', () => {
    const r = calcBaud('stm32', 72e6, 115200, D)
    expect(r.reg).toBe('BRR = 0x0271')
    expect(r.errorPct).toBeCloseTo(0, 9)
  })
  it('8 MHz, 115200: USARTDIV 4.3125 (4 + 5/16), +0.64 %', () => {
    const r = calcBaud('stm32', 8e6, 115200, D)
    expect(r.divider).toBe('USARTDIV = 4 + 5/16')
    expect(r.errorPct).toBeCloseTo(0.644, 2)
  })
  it('oversampling by 8 uses 3 fraction bits and the same N = fck/baud', () => {
    const r = calcBaud('stm32', 8e6, 115200, { ...D, over8: true })
    expect(r.divider).toBe('USARTDIV = 8 + 5/8')
    expect(r.reg).toBe('BRR = 0x0085')
    expect(r.actual).toBeCloseTo(8e6 / 69, 6)
  })
  it('rejects a baud rate above fck/16', () => {
    expect(calcBaud('stm32', 8e6, 1e6, D).ok).toBe(false)
    expect(calcBaud('stm32', 8e6, 1e6, { ...D, over8: true }).ok).toBe(true)
  })
})

describe('STM32 LPUART', () => {
  it('32.768 kHz, 9600: BRR = 874.5 → 0x36B or 0x36A, error below 0.06 %', () => {
    const r = calcBaud('stm32lp', 32768, 9600, D)
    expect(r.ok).toBe(true)
    expect(Math.abs(r.errorPct)).toBeLessThan(0.06)
  })
  it('rejects BRR < 0x300', () => {
    expect(calcBaud('stm32lp', 32768, 19200, D).ok).toBe(false)
  })
})

describe('ESP32', () => {
  it('80 MHz, 115200: 694 + 7/16', () => {
    const r = calcBaud('esp32', 80e6, 115200, D)
    expect(r.divider).toBe('div = 694 + 7/16')
    expect(Math.abs(r.errorPct)).toBeLessThan(0.002)
  })
})

describe('RP2040', () => {
  it('125 MHz, 115200: IBRD 67, FBRD 52 (Pico SDK values)', () => {
    const r = calcBaud('rp2040', 125e6, 115200, D)
    expect(r.divider).toBe('IBRD = 67, FBRD = 52')
    expect(r.actual).toBeCloseTo(115207.4, 0)
  })
})

describe('generic', () => {
  it('1.8432 MHz, x16: divisors 12 for 9600 and 1 for 115200, all exact', () => {
    expect(calcBaud('generic', 1.8432e6, 9600, D).divider).toBe('div = 12')
    expect(calcBaud('generic', 1.8432e6, 115200, D).errorPct).toBeCloseTo(0, 9)
  })
  it('fractional bits shrink the error', () => {
    const i = calcBaud('generic', 16e6, 115200, D)
    const f = calcBaud('generic', 16e6, 115200, { ...D, fracBits: 4 })
    expect(Math.abs(f.errorPct)).toBeLessThan(Math.abs(i.errorPct))
  })
})

describe('tables and suggestions', () => {
  it('builds one row per standard baud', () => {
    expect(baudTable('avr', 16e6, D)).toHaveLength(22)
  })
  it('finds UART crystals with zero error', () => {
    const s = suggestCrystals('avr', D, [9600, 115200])
    expect(s[0].worstPct).toBeCloseTo(0, 9)
    expect([1.8432e6, 3.6864e6, 7.3728e6, 11.0592e6, 14.7456e6, 18.432e6]).toContain(s[0].clock)
    expect(s.find((x) => x.clock === 16e6)!.worstPct).toBeGreaterThan(3)
  })
  it('max good baud', () => {
    expect(maxGoodBaud('avr', 16e6, D, 2)).toBe(1000000)
    expect(maxGoodBaud('avr', 14.7456e6, D, 0.01)).toBe(921600)
  })
  it('grades errors', () => {
    expect(gradeError(0.5)).toBe('good')
    expect(gradeError(1.5)).toBe('ok')
    expect(gradeError(-2.5)).toBe('marginal')
    expect(gradeError(3.6)).toBe('bad')
    expect(gradeError(1.9, 20000)).toBe('bad')
  })
  it('parses bauds', () => {
    expect(parseBaudList('9600, 115200 foo 0')).toEqual([9600, 115200])
  })
})
