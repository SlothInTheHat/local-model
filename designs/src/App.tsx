import {
  useState,
  useRef,
  useEffect,
  useCallback,
  type CSSProperties,
} from 'react'

// ─── Types ────────────────────────────────────────────────────────────────────

type Mode = 'chat' | 'research' | 'code' | 'memory' | 'settings'
type AppStatus = 'idle' | 'thinking' | 'running'

interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
}

// ─── Seed data ────────────────────────────────────────────────────────────────

const SEED_MESSAGES: Message[] = [
  {
    id: '1',
    role: 'assistant',
    content: "Good morning. I'm ready — what would you like to work on today?",
  },
  {
    id: '2',
    role: 'user',
    content: 'Schedule a task that appends the current date to notes.md every 24 hours.',
  },
  {
    id: '3',
    role: 'assistant',
    content:
      'Done. Job id: 5c6fb652-ce86-42f4 — running daily at midnight. I\'ll alert you if it ever misses a run.',
  },
  {
    id: '4',
    role: 'user',
    content: "What's on my calendar today?",
  },
  {
    id: '5',
    role: 'assistant',
    content:
      'Three items: 10 am standup (recurring), lunch blocked 12–1 pm, 3 pm product review. Nothing after 5. Want me to draft anything for the review?',
  },
]

const MODES: { id: Mode; label: string }[] = [
  { id: 'chat',     label: 'Chat'     },
  { id: 'research', label: 'Research' },
  { id: 'code',     label: 'Code'     },
  { id: 'memory',   label: 'Memory'   },
  { id: 'settings', label: 'Settings' },
]

// ─── Organic blob radii ───────────────────────────────────────────────────────

const USER_R = ['20px 20px 3px 20px', '22px 20px 5px 20px', '20px 24px 3px 20px']
const AI_R   = ['3px 20px 20px 20px', '5px 22px 20px 20px', '3px 20px 24px 20px']

// ─── Nucleus (floating pill inside the pill) ──────────────────────────────────

function Nucleus({
  mode,
  status,
  onModeChange,
}: {
  mode: Mode
  status: AppStatus
  onModeChange: (m: Mode) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [])

  const label = MODES.find((m) => m.id === mode)?.label ?? 'Chat'

  return (
    <div className="flex justify-center px-4 pt-3.5 pb-0 shrink-0" ref={ref}>
      <div
        onClick={() => setOpen((o) => !o)}
        style={{
          transition: 'width 0.45s cubic-bezier(0.34, 1.4, 0.64, 1)',
          width: open ? '100%' : status !== 'idle' ? '190px' : '162px',
          cursor: 'pointer',
        }}
        className="bg-[#0A0A0A] rounded-full overflow-hidden select-none"
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === 'Enter' && setOpen((o) => !o)}
      >
        {open ? (
          <div className="flex items-center gap-0.5 px-2 py-2 justify-center">
            {MODES.map((m) => (
              <button
                key={m.id}
                onClick={(e) => {
                  e.stopPropagation()
                  onModeChange(m.id)
                  setOpen(false)
                }}
                className={`px-3 py-1.5 rounded-full text-[11px] font-medium whitespace-nowrap transition-colors duration-150 ${
                  m.id === mode
                    ? 'bg-white text-[#0A0A0A]'
                    : 'text-white/50 hover:text-white/90'
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>
        ) : (
          <div className="flex items-center justify-center gap-2.5 px-5 py-2.5">
            {status !== 'idle' ? (
              <>
                <span className="text-white/70 text-[11px] tracking-wide">
                  {status === 'thinking' ? 'Thinking' : 'Working'}
                </span>
                <PulseDots />
              </>
            ) : (
              <>
                <span className="text-white text-[11px] font-medium tracking-wide">{label}</span>
                <span className="w-px h-3 bg-white/20" />
                <span className="text-white/35 text-[11px] font-mono">qwen3:14b</span>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function PulseDots() {
  return (
    <div className="flex gap-[3px] items-center">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="block w-1 h-1 rounded-full bg-white"
          style={{ animation: 'ndot 1.4s ease-in-out infinite', animationDelay: `${i * 0.18}s` }}
        />
      ))}
    </div>
  )
}

// ─── Chat ─────────────────────────────────────────────────────────────────────

function ChatView({ messages, thinking }: { messages: Message[]; thinking: boolean }) {
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, thinking])

  return (
    <div className="flex flex-col gap-3 px-4 py-4">
      {messages.map((msg, i) => {
        const isUser = msg.role === 'user'
        const r = (isUser ? USER_R : AI_R)[i % 3]
        return (
          <div key={msg.id} className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
            <div
              style={{ borderRadius: r, maxWidth: '78%', animation: 'msgIn 0.28s cubic-bezier(0.34, 1.3, 0.64, 1)' }}
              className={`px-4 py-2.5 text-sm leading-[1.65] ${
                isUser
                  ? 'bg-[#0A0A0A] text-white'
                  : 'bg-white border border-black/[0.07] text-[#111]'
              }`}
            >
              {msg.content}
            </div>
          </div>
        )
      })}
      {thinking && (
        <div className="flex justify-start">
          <div style={{ borderRadius: '3px 18px 18px 18px', animation: 'msgIn 0.28s ease' }}
            className="px-4 py-3 bg-white border border-black/[0.07]">
            <div className="flex gap-1.5 items-center h-4">
              {[0, 1, 2].map((i) => (
                <span key={i} className="block w-1.5 h-1.5 rounded-full bg-black/25"
                  style={{ animation: 'nbounce 1s ease-in-out infinite', animationDelay: `${i * 0.14}s` }} />
              ))}
            </div>
          </div>
        </div>
      )}
      <div ref={bottomRef} />
    </div>
  )
}

// ─── Research ─────────────────────────────────────────────────────────────────

const RESEARCH = [
  { query: 'node-cron scheduled tasks — best practices', sources: 4,
    summary: 'node-cron uses POSIX cron syntax. For append tasks, use fs.appendFileSync inside the callback. Catch errors locally to avoid silent failures.' },
  { query: 'Google Calendar API — read-only integration', sources: 9,
    summary: 'OAuth2 required. Use googleapis npm package. Scopes: calendar.readonly. Persist tokens in a local keychain to avoid re-auth on every run.' },
]

function ResearchView() {
  return (
    <div className="px-4 py-4 space-y-3">
      <SectionLabel>Deep Research</SectionLabel>
      {RESEARCH.map((item, i) => (
        <div key={i} className="bg-white border border-black/[0.07] rounded-2xl p-4 space-y-1.5"
          style={{ animation: `fadeUp 0.3s ease ${i * 0.07}s both` }}>
          <div className="text-sm font-semibold text-[#111]">{item.query}</div>
          <div className="text-[11px] text-black/35">{item.sources} sources analyzed</div>
          <p className="text-sm text-black/55 leading-relaxed pt-0.5">{item.summary}</p>
        </div>
      ))}
      <div className="py-8 text-center text-sm text-black/20">Start a new research query below</div>
    </div>
  )
}

// ─── Code ─────────────────────────────────────────────────────────────────────

const CODE = `// notes-scheduler.js
import { schedule } from 'node-cron'
import { appendFileSync } from 'fs'

// Runs at midnight every day
schedule('0 0 * * *', () => {
  const entry = new Date().toISOString()
  try {
    appendFileSync('notes.md', \`\\n## \${entry}\\n\`)
    console.log('[cron] appended to notes.md')
  } catch (err) {
    console.error('[cron] write failed:', err)
  }
})`

function CodeView() {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    navigator.clipboard.writeText(CODE)
    setCopied(true)
    setTimeout(() => setCopied(false), 1800)
  }
  return (
    <div className="px-4 py-4 space-y-3">
      <SectionLabel>Code</SectionLabel>
      <div className="flex items-center gap-2">
        <span className="bg-[#0A0A0A] text-white text-[10.5px] px-3 py-1 rounded-full font-mono">
          notes-scheduler.js
        </span>
        <span className="text-[11px] text-black/30">last run 3 min ago · ok</span>
      </div>
      <div className="bg-white border border-black/[0.07] rounded-2xl overflow-hidden">
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-black/[0.04]">
          <div className="flex gap-1.5">
            {[0,1,2].map(i => <span key={i} className="block w-2.5 h-2.5 rounded-full bg-black/10" />)}
          </div>
          <button onClick={copy} className="text-[11px] text-black/30 hover:text-black/60 transition-colors">
            {copied ? 'copied ✓' : 'copy'}
          </button>
        </div>
        <pre className="px-5 py-4 text-[12px] font-mono text-[#111] leading-[1.85] overflow-x-auto">
          {CODE}
        </pre>
      </div>
    </div>
  )
}

// ─── Memory ───────────────────────────────────────────────────────────────────

const MEMORIES = [
  { title: 'Daily notes task',    body: 'Appends ISO timestamp to notes.md at midnight. Job 5c6fb652.', tag: 'Automation' },
  { title: 'Workspace',          body: 'C:/Users/alave/Documents/LocalMind-test',                      tag: 'Config'     },
  { title: 'Active model',       body: 'qwen3:14b — fast local reasoning, 14B params.',                tag: 'Config'     },
  { title: 'Calendar prefs',     body: 'Prefers morning briefings. Uses Google Calendar for reads.',    tag: 'Prefs'      },
  { title: 'Standup',            body: 'Every weekday 10 am. Never schedule over it.',                 tag: 'Calendar'   },
  { title: 'Voice shortcut',     body: 'Ctrl+Space → voice input from anywhere.',                      tag: 'Config'     },
]

const MEM_R = ['14px', '20px 6px 20px 6px', '6px 20px 6px 20px', '14px', '20px 6px', '6px 20px']

function MemoryView() {
  return (
    <div className="px-4 py-4">
      <SectionLabel className="mb-3">Memory</SectionLabel>
      <div className="grid grid-cols-2 gap-2.5">
        {MEMORIES.map((m, i) => (
          <div key={i}
            style={{ borderRadius: MEM_R[i % MEM_R.length], animation: `fadeUp 0.3s ease ${i * 0.04}s both` }}
            className="bg-white border border-black/[0.07] p-3.5 space-y-1 hover:border-black/20 transition-colors cursor-default">
            <span className="text-[9.5px] uppercase tracking-[0.13em] text-black/25 font-medium">{m.tag}</span>
            <div className="text-[13px] font-semibold text-[#111] leading-snug">{m.title}</div>
            <p className="text-[11.5px] text-black/50 leading-relaxed">{m.body}</p>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Settings ─────────────────────────────────────────────────────────────────

function Toggle({ value, onChange }: { value: boolean; onChange: () => void }) {
  return (
    <button onClick={onChange} role="switch" aria-checked={value}
      className={`w-10 h-[22px] rounded-full relative shrink-0 transition-colors duration-200 ${value ? 'bg-[#0A0A0A]' : 'bg-black/12'}`}>
      <span style={{ transition: 'left 0.2s ease', left: value ? '20px' : '2px' }}
        className="absolute top-[3px] w-4 h-4 rounded-full bg-white shadow-sm" />
    </button>
  )
}

function SettingsView() {
  const [model, setModel] = useState('qwen3:14b')
  const [privacy, setPrivacy] = useState(true)
  const [stream, setStream] = useState(true)
  const [extCtx, setExtCtx] = useState(false)

  return (
    <div className="px-4 py-4 space-y-3">
      <SectionLabel>Settings</SectionLabel>
      <div className="bg-white border border-black/[0.07] rounded-2xl px-4 py-3.5 flex items-center justify-between">
        <div>
          <div className="text-[13px] font-semibold text-[#111]">Active model</div>
          <div className="text-[11px] text-black/40 mt-0.5">Local inference</div>
        </div>
        <select value={model} onChange={e => setModel(e.target.value)}
          className="text-[12px] bg-[#F5F3EE] rounded-full px-3 py-1.5 text-[#111] outline-none border-none cursor-pointer">
          <option>qwen3:14b</option>
          <option>llama3.2:latest</option>
          <option>mistral:7b</option>
          <option>claude-3-5-haiku</option>
        </select>
      </div>
      <div className="bg-white border border-black/[0.07] rounded-2xl overflow-hidden divide-y divide-black/[0.04]">
        {[
          { label: 'Private mode',     desc: 'All data stays on-device',          val: privacy, set: () => setPrivacy(p => !p) },
          { label: 'Streaming',        desc: 'Token-by-token display',             val: stream,  set: () => setStream(s => !s) },
          { label: 'Extended context', desc: 'Use full 32k window (slower)',       val: extCtx,  set: () => setExtCtx(c => !c) },
        ].map(({ label, desc, val, set }) => (
          <div key={label} className="px-4 py-3.5 flex items-center justify-between">
            <div>
              <div className="text-[13px] font-semibold text-[#111]">{label}</div>
              <div className="text-[11px] text-black/40 mt-0.5">{desc}</div>
            </div>
            <Toggle value={val} onChange={set} />
          </div>
        ))}
      </div>
      <div className="bg-white border border-black/[0.07] rounded-2xl px-4 py-3.5">
        <div className="text-[13px] font-semibold text-[#111] mb-1">Workspace</div>
        <code className="text-[11px] font-mono text-black/40">C:/Users/alave/Documents/LocalMind-test</code>
      </div>
    </div>
  )
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function SectionLabel({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`text-[9.5px] uppercase tracking-[0.15em] text-black/25 font-medium ${className}`}>
      {children}
    </div>
  )
}

// ─── Input ────────────────────────────────────────────────────────────────────

const PLACEHOLDERS: Record<Mode, string> = {
  chat:     'Ask anything…',
  research: 'Research a topic…',
  code:     'Describe what to build…',
  memory:   'Search memory…',
  settings: 'Find a setting…',
}

function InputBar({ mode, onSend }: { mode: Mode; onSend: (t: string) => void }) {
  const [val, setVal] = useState('')
  const taRef = useRef<HTMLTextAreaElement>(null)

  const send = () => {
    if (!val.trim()) return
    onSend(val.trim())
    setVal('')
    if (taRef.current) taRef.current.style.height = 'auto'
  }

  const resize = () => {
    const el = taRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 112)}px`
  }

  return (
    <div className="px-3 pb-3 pt-2 shrink-0 border-t border-black/[0.05]">
      <div className="flex items-end gap-2 bg-white border border-black/[0.08] rounded-2xl px-3.5 py-2.5 shadow-[0_1px_8px_rgba(0,0,0,0.04)]">
        <textarea ref={taRef} value={val}
          onChange={e => { setVal(e.target.value); resize() }}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
          placeholder={PLACEHOLDERS[mode]} rows={1}
          className="flex-1 resize-none text-[13px] text-[#111] placeholder:text-black/22 outline-none leading-[1.6] bg-transparent"
          style={{ maxHeight: 112, overflow: 'hidden' }}
        />
        <div className="flex items-center gap-1 shrink-0 pb-px">
          <button className="w-7 h-7 rounded-full flex items-center justify-center text-black/22 hover:text-black/50 transition-colors">
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
              <path d="M6.5 1v11M1 6.5h11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
            </svg>
          </button>
          <button className="w-7 h-7 rounded-full flex items-center justify-center text-black/22 hover:text-black/50 transition-colors">
            <svg width="11" height="13" viewBox="0 0 11 13" fill="none">
              <rect x="2.5" y="0.5" width="6" height="7" rx="3" stroke="currentColor" strokeWidth="1.3"/>
              <path d="M0.5 7a5 5 0 0010 0M5.5 12v1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
            </svg>
          </button>
          <button onClick={send} disabled={!val.trim()}
            className="w-8 h-8 rounded-full bg-[#0A0A0A] flex items-center justify-center disabled:opacity-20 hover:opacity-75 transition-opacity">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M1.5 10.5L10.5 6 1.5 1.5v3.25l7 1.25-7 1.25V10.5z" fill="white"/>
            </svg>
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Root ─────────────────────────────────────────────────────────────────────

export default function App() {
  const [mode, setMode]       = useState<Mode>('chat')
  const [status, setStatus]   = useState<AppStatus>('idle')
  const [messages, setMessages] = useState<Message[]>(SEED_MESSAGES)
  const [contentKey, setContentKey] = useState(0)

  // Pill morph state
  const [pillState, setPillState] = useState<'seed' | 'compact' | 'expanded'>('seed')

  useEffect(() => {
    // seed → compact → expanded on mount
    const t1 = setTimeout(() => setPillState('compact'), 60)
    const t2 = setTimeout(() => setPillState('expanded'), 240)
    return () => { clearTimeout(t1); clearTimeout(t2) }
  }, [])

  const switchMode = useCallback((m: Mode) => {
    setMode(m)
    setContentKey((k) => k + 1)
  }, [])

  const handleSend = useCallback((text: string) => {
    if (mode !== 'chat') return
    const userMsg: Message = { id: `u${Date.now()}`, role: 'user', content: text }
    setMessages((prev) => [...prev, userMsg])
    setStatus('thinking')
    setTimeout(() => {
      setStatus('idle')
      setMessages((prev) => [...prev, {
        id: `a${Date.now()}`,
        role: 'assistant',
        content: "Got it — looking into that now. I'll update you as soon as I have something concrete.",
      }])
    }, 1600 + Math.random() * 700)
  }, [mode])

  // ── Pill dimensions ──────────────────────────────────────────────────────────
  const isExpanded = pillState === 'expanded'
  const isCompact  = pillState === 'compact'

  const pillStyle: CSSProperties = {
    position: 'fixed',
    top: '18px',
    left: '50%',
    transform: 'translateX(-50%)',
    zIndex: 50,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',

    // Morph sizes
    width: isExpanded
      ? 'min(580px, calc(100vw - 24px))'
      : isCompact
      ? '160px'
      : '0px',

    height: isExpanded
      ? 'calc(100dvh - 36px)'
      : isCompact
      ? '40px'
      : '0px',

    borderRadius: isExpanded ? '26px' : '9999px',

    background: isExpanded ? '#FAFAF9' : '#0A0A0A',
    border: isExpanded
      ? '1px solid rgba(0,0,0,0.09)'
      : '1px solid transparent',
    boxShadow: isExpanded
      ? '0 8px 60px rgba(0,0,0,0.1), 0 2px 8px rgba(0,0,0,0.05)'
      : '0 2px 16px rgba(0,0,0,0.18)',

    transition: [
      'width   0.65s cubic-bezier(0.34, 1.12, 0.64, 1)',
      'height  0.65s cubic-bezier(0.34, 1.12, 0.64, 1)',
      'border-radius 0.65s cubic-bezier(0.34, 1.12, 0.64, 1)',
      'background 0.4s ease',
      'box-shadow 0.4s ease',
    ].join(', '),
  }

  return (
    <>
      {/* Paper grain overlay */}
      <div className="fixed inset-0 pointer-events-none" style={{
        zIndex: 200,
        opacity: 0.02,
        backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='250' height='250'%3E%3Cfilter id='g'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.82' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23g)'/%3E%3C/svg%3E")`,
        backgroundSize: '250px 250px',
      }} />

      {/* Paper background */}
      <div className="fixed inset-0 bg-[#F0EDE7]" style={{ zIndex: 0 }} />

      {/* THE MORPHING PILL */}
      <div style={pillStyle}>

        {/* ── Compact state label ── */}
        {!isExpanded && (
          <div className="flex items-center justify-center h-full px-5 gap-2">
            <span className="text-white/90 text-[11px] font-medium tracking-wide">LocalMind</span>
          </div>
        )}

        {/* ── Expanded state ── */}
        {isExpanded && (
          <>
            {/* Nucleus: floating black pill inside the white pill */}
            <Nucleus mode={mode} status={status} onModeChange={switchMode} />

            {/* Hairline divider */}
            <div className="mx-4 mt-3 border-t border-black/[0.05] shrink-0" />

            {/* Scrollable content */}
            <div
              key={contentKey}
              className="flex-1 overflow-y-auto"
              style={{
                scrollbarWidth: 'none',
                animation: 'contentIn 0.35s cubic-bezier(0.34, 1.2, 0.64, 1)',
              }}
            >
              {mode === 'chat'     && <ChatView messages={messages} thinking={status === 'thinking'} />}
              {mode === 'research' && <ResearchView />}
              {mode === 'code'     && <CodeView />}
              {mode === 'memory'   && <MemoryView />}
              {mode === 'settings' && <SettingsView />}
            </div>

            {/* Input bar — fixed at bottom of pill */}
            <InputBar mode={mode} onSend={handleSend} />
          </>
        )}
      </div>

      <style>{`
        @keyframes ndot {
          0%, 100% { opacity: 0.25; transform: scale(0.75); }
          50%       { opacity: 1;    transform: scale(1);    }
        }
        @keyframes nbounce {
          0%, 100% { transform: translateY(0); }
          50%       { transform: translateY(-4px); }
        }
        @keyframes msgIn {
          from { opacity: 0; transform: translateY(6px) scale(0.97); }
          to   { opacity: 1; transform: none; }
        }
        @keyframes fadeUp {
          from { opacity: 0; transform: translateY(8px); }
          to   { opacity: 1; transform: none; }
        }
        @keyframes contentIn {
          from { opacity: 0; transform: translateY(10px); }
          to   { opacity: 1; transform: none; }
        }
      `}</style>
    </>
  )
}
