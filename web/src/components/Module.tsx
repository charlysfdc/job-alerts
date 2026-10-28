import { useEffect, useState, type ReactNode } from 'react'

const KEY = 'ja.module.'

function remembered(id: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(KEY + id)
    return v === null ? fallback : v === '1'
  } catch {
    return fallback
  }
}

function remember(id: string, open: boolean) {
  try { localStorage.setItem(KEY + id, open ? '1' : '0') } catch { /* storage blocked: nothing to remember */ }
}

/** Tell every module on the page to open or close (the Expand all / Collapse all buttons). */
export function setAllModules(open: boolean) {
  window.dispatchEvent(new CustomEvent('ja-modules', { detail: open }))
}

interface ModuleProps {
  /** Stable name; the open/closed state is remembered per name across people. */
  id: string
  title: string
  count?: number
  /** One line shown under the title, open or closed. */
  summary?: ReactNode
  defaultOpen?: boolean
  /** Open regardless of what was remembered (e.g. open questions). */
  forceOpen?: boolean
  tone?: 'ask'
  className?: string
  children: ReactNode
}

export function Module({ id, title, count, summary, defaultOpen = false, forceOpen, tone, className, children }: ModuleProps) {
  const [open, setOpen] = useState(() => forceOpen || remembered(id, defaultOpen))
  useEffect(() => {
    const on = (e: Event) => {
      const next = (e as CustomEvent<boolean>).detail
      setOpen(next)
      remember(id, next)
    }
    window.addEventListener('ja-modules', on)
    return () => window.removeEventListener('ja-modules', on)
  }, [id])

  const toggle = () => {
    setOpen(!open)
    remember(id, !open)
  }

  return (
    <section className={['card', 'module', tone === 'ask' ? 'module-ask' : '', className ?? ''].join(' ').trim()}>
      <button className="module-head" onClick={toggle} aria-expanded={open}>
        <span className="module-title">
          {title}
          {count !== undefined && <span className={tone === 'ask' && count > 0 ? 'count count-ask' : 'count'}>{count}</span>}
        </span>
        <span className="module-caret" aria-hidden>{open ? '−' : '+'}</span>
      </button>
      {summary && <div className="module-summary">{summary}</div>}
      {open && <div className="module-body">{children}</div>}
    </section>
  )
}
