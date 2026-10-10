import { useEffect, useMemo, useState } from 'react'
import { baudTable, calcBaud, DEFAULT_OPTIONS, FAMILIES, gradeError, maxGoodBaud, parseBaudList, STANDARD_BAUDS, suggestCrystals, type FamilyId, type Grade, type Options } from './lib/baud'
import { tr, type T } from './i18n'
import { useSettings, useStored } from './settings'
import { download, Shell } from './ui'

interface State {
  family: FamilyId
  clockMHz: number
  opts: Options
  baud: number
  limit: number
  ppm: number
  wanted: number[]
}

const INITIAL: State = { family: 'avr', clockMHz: 16, opts: DEFAULT_OPTIONS, baud: 115200, limit: 2, ppm: 0, wanted: [9600, 115200] }

function fromHash(): State | null {
  try {
    if (location.hash.length > 1) return { ...INITIAL, ...JSON.parse(decodeURIComponent(location.hash.slice(1))) }
  } catch { /* ignore a broken link */ }
  return null
}

const GRADE_CLASS: Record<Grade, string> = { good: 'ok-text', ok: 'ok-text', marginal: 'warn-text', bad: 'err-text' }
const GRADE_LABEL: Record<Grade, string> = { good: 'Excellent', ok: 'OK', marginal: 'Marginal', bad: 'Too high' }
const pct = (x: number): string => (Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${x.toFixed(Math.abs(x) < 0.01 ? 4 : 2)} %` : '-')
const hz = (x: number): string => (x >= 1e6 ? `${+(x / 1e6).toFixed(6)} MHz` : x >= 1e3 ? `${+(x / 1e3).toFixed(3)} kHz` : `${x} Hz`)

function ErrBar({ e, limit }: { e: number; limit: number }) {
  const w = Math.min(50, (Math.abs(e) / (limit * 2)) * 50)
  const c = gradeError(e, 0, limit)
  return (
    <span className="errbar" aria-hidden>
      <span className={`errfill ${c}`} style={{ width: `${w}%`, [e < 0 ? 'right' : 'left']: '50%' }} />
    </span>
  )
}

export default function App() {
  const [settings, setSettings] = useSettings()
  const t: T = (s, ...a) => tr(settings.lang, s, ...a)
  const [state, setState] = useStored<State>('state', INITIAL)
  const [bauds, setBauds] = useState(() => state.wanted.join(', '))
  useEffect(() => {
    const h = fromHash()
    if (h) setState(h)
  }, [])
  const set = (p: Partial<State>) => setState((s) => ({ ...s, ...p }))
  const setOpt = (p: Partial<Options>) => setState((s) => ({ ...s, opts: { ...s.opts, ...p } }))
  const { family, opts, limit, ppm } = state
  const clock = state.clockMHz * 1e6
  const fam = FAMILIES.find((f) => f.id === family)!
  const result = calcBaud(family, clock, state.baud, opts)
  const rows = useMemo(() => baudTable(family, clock, opts), [family, clock, opts])
  const wanted = state.wanted
  const sugg = useMemo(() => suggestCrystals(family, opts, wanted.length ? wanted : [9600]).slice(0, 10), [family, opts, wanted])
  const best = maxGoodBaud(family, clock, opts, limit)
  const [copied, setCopied] = useState(false)

  const exportCsv = () => {
    const lines = ['baud,divider,register,actual_baud,error_percent']
    for (const r of rows) lines.push([r.baud, `"${r.result.divider}"`, `"${r.result.reg}"`, r.result.ok ? r.result.actual.toFixed(3) : '', r.result.ok ? r.result.errorPct.toFixed(4) : ''].join(','))
    download('baud-errors.csv', lines.join('\n'), 'text/csv')
  }
  const share = async () => {
    const url = `${location.origin}${location.pathname}#${encodeURIComponent(JSON.stringify(state))}`
    history.replaceState(null, '', url)
    try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch { /* clipboard blocked */ }
  }
  const bad = !(state.clockMHz > 0) || !(state.baud > 0)

  return (
    <Shell title="Baud Rate Error Calculator" subtitle="UART divider, actual baud and % error for STM32, AVR, ESP32, RP2040 and generic UARTs." settings={settings} onSettings={setSettings} t={t}>
      <div className="cols">
        <div className="box">
          <h3>{t('Hardware')}</h3>
          <div className="field">
            <label htmlFor="fam">{t('UART peripheral')}</label>
            <select id="fam" value={family} onChange={(e) => { const f = FAMILIES.find((x) => x.id === e.target.value)!; set({ family: f.id, clockMHz: f.presets[Math.min(2, f.presets.length - 1)][1] / 1e6 }) }}>
              {FAMILIES.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          </div>
          <div className="grid2">
            <div className="field">
              <label htmlFor="clk">{t('Clock (MHz)')}</label>
              <input id="clk" type="number" step="any" min="0" className={state.clockMHz > 0 ? '' : 'bad'} value={state.clockMHz} onChange={(e) => set({ clockMHz: +e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="baud">{t('Target baud')}</label>
              <input id="baud" type="number" min="1" list="bauds" className={state.baud > 0 ? '' : 'bad'} value={state.baud} onChange={(e) => set({ baud: +e.target.value })} />
              <datalist id="bauds">{STANDARD_BAUDS.map((b) => <option key={b} value={b} />)}</datalist>
            </div>
          </div>
          <div className="row">
            {fam.presets.map(([label, v]) => <button key={label} className="small" onClick={() => set({ clockMHz: v / 1e6 })}>{label}</button>)}
          </div>
          {family === 'stm32' && (
            <label className="inline"><input type="checkbox" checked={opts.over8} onChange={(e) => setOpt({ over8: e.target.checked })} /> {t('Oversampling by 8 (OVER8 = 1)')}</label>
          )}
          {family === 'avr' && (
            <label className="inline"><input type="checkbox" checked={opts.u2x} onChange={(e) => setOpt({ u2x: e.target.checked })} /> {t('Double speed (U2X = 1)')}</label>
          )}
          {family === 'generic' && (
            <div className="grid2">
              <div className="field">
                <label htmlFor="os">{t('Oversampling (samples per bit)')}</label>
                <input id="os" type="number" min="1" value={opts.oversample} onChange={(e) => setOpt({ oversample: +e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="fb">{t('Fractional divider bits')}</label>
                <input id="fb" type="number" min="0" max="16" value={opts.fracBits} onChange={(e) => setOpt({ fracBits: +e.target.value })} />
              </div>
            </div>
          )}
          <div className="grid2">
            <div className="field">
              <label htmlFor="lim">{t('Acceptable error (±%)')}</label>
              <input id="lim" type="number" step="0.1" min="0.1" value={limit} onChange={(e) => set({ limit: +e.target.value || 2 })} />
            </div>
            <div className="field">
              <label htmlFor="ppm">{t('Oscillator tolerance (±ppm)')}</label>
              <input id="ppm" type="number" min="0" value={ppm} onChange={(e) => set({ ppm: +e.target.value || 0 })} />
            </div>
          </div>
          <p className="hint">{t('Both ends add up: keep the sum of the two UARTs\' errors, plus oscillator drift, under about 2 % for reliable 8N1 reception.')}</p>
          <div className="row">
            <button onClick={share}>{copied ? t('Link copied') : t('Copy link')}</button>
            <button onClick={() => set({ ...INITIAL })}>{t('Reset')}</button>
          </div>
        </div>

        <div className="box">
          <h3>{t('Result')}</h3>
          {bad ? <p className="err-text">{t('Enter a positive clock and baud rate.')}</p> : !result.ok ? (
            <p className="err-text">{t(result.problem ?? '')}</p>
          ) : (
            <>
              <div className="result-grid">
                <div><span className="hint">{t('Divider')}</span><div className="big mono">{result.divider}</div></div>
                <div><span className="hint">{t('Register')}</span><div className="big mono">{result.reg}</div></div>
                <div><span className="hint">{t('Actual baud')}</span><div className="big mono">{result.actual.toFixed(2)}</div></div>
                <div>
                  <span className="hint">{t('Error')}</span>
                  <div className={`big mono ${GRADE_CLASS[gradeError(result.errorPct, ppm, limit)]}`}>{pct(result.errorPct)}</div>
                  <span className={GRADE_CLASS[gradeError(result.errorPct, ppm, limit)]}>{t(GRADE_LABEL[gradeError(result.errorPct, ppm, limit)])}</span>
                  {ppm > 0 && <span className="hint"> {t('worst case {0}', pct(Math.sign(result.errorPct || 1) * (Math.abs(result.errorPct) + ppm / 1e4)))}</span>}
                </div>
              </div>
              <pre className="steps">{result.steps.join('\n')}</pre>
            </>
          )}
          {best && <p className="hint">{t('Highest standard baud within ±{0} % at {1}: {2}', limit, hz(clock), best)}</p>}
        </div>
      </div>

      <div className="box">
        <div className="row">
          <h3 style={{ margin: 0 }}>{t('Standard baud rates at {0}', hz(clock))}</h3>
          <span className="spacer" />
          <button className="small" onClick={exportCsv}>{t('Export CSV')}</button>
        </div>
        <div className="scroll">
          <table className="data">
            <thead><tr><th>{t('Baud')}</th><th>{t('Divider')}</th><th>{t('Register')}</th><th>{t('Actual')}</th><th>{t('Error')}</th><th /></tr></thead>
            <tbody>
              {rows.map(({ baud, result: r }) => (
                <tr key={baud} className={baud === state.baud ? 'active' : ''} onClick={() => set({ baud })} style={{ cursor: 'pointer' }}>
                  <td className="mono">{baud}</td>
                  <td className="mono">{r.divider}</td>
                  <td className="mono">{r.reg}</td>
                  <td className="mono">{r.ok ? r.actual.toFixed(1) : '-'}</td>
                  <td className={`mono ${r.ok ? GRADE_CLASS[gradeError(r.errorPct, ppm, limit)] : 'hint'}`}>{r.ok ? pct(r.errorPct) : t('n/a')}</td>
                  <td>{r.ok && <ErrBar e={r.errorPct} limit={limit} />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="box">
        <h3>{t('Best crystal for your baud rates')}</h3>
        <div className="row">
          <label htmlFor="wanted">{t('Baud rates needed')}</label>
          <input id="wanted" type="text" value={bauds} style={{ flex: 1, minWidth: 200 }} onChange={(e) => { setBauds(e.target.value); set({ wanted: parseBaudList(e.target.value) }) }} />
        </div>
        <p className="hint">{t('Ranked by the worst error over all listed rates, using the peripheral and options selected above. Click a row to use that clock.')}</p>
        <div className="scroll">
          <table className="data">
            <thead><tr><th>{t('Crystal / clock')}</th><th>{t('Worst error')}</th><th>{t('Per baud')}</th></tr></thead>
            <tbody>
              {sugg.map((s) => (
                <tr key={s.clock} onClick={() => set({ clockMHz: s.clock / 1e6 })} style={{ cursor: 'pointer' }} className={s.clock === clock ? 'active' : ''}>
                  <td className="mono">{hz(s.clock)}</td>
                  <td className={`mono ${GRADE_CLASS[gradeError(s.worstPct, 0, limit)]}`}>{s.worstPct.toFixed(Math.abs(s.worstPct) < 0.01 ? 4 : 2)} %</td>
                  <td className="mono hint">{s.errors.map((e, i) => `${wanted[i]}: ${pct(e)}`).join('   ')}</td>
                </tr>
              ))}
              {sugg.length === 0 && <tr><td colSpan={3} className="hint">{t('No standard crystal can produce all of these rates.')}</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </Shell>
  )
}
