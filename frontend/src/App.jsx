import { useState, useRef, useCallback, useEffect } from 'react'
import { Upload, Zap, Video, Image, Activity, Target, Wind, BarChart3, Mic2, ChevronRight, RefreshCw, MessageCircle, Radio, StopCircle } from 'lucide-react'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts'
import WagonWheel from './components/WagonWheel.jsx'
import CommentaryCard from './components/CommentaryCard.jsx'
import StatCard from './components/StatCard.jsx'
import FrameTimeline from './components/FrameTimeline.jsx'
import AskAnalyst from './components/AskAnalyst.jsx'

const API = 'http://localhost:5001'

const DEMO_SHOTS = [
  { label: 'Cover Drive', value: 3, color: '#22c55e' },
  { label: 'Pull Shot', value: 2, color: '#3b82f6' },
  { label: 'Sweep', value: 1, color: '#f59e0b' },
  { label: 'Cut Shot', value: 2, color: '#a855f7' },
  { label: 'Defensive', value: 1, color: '#94a3b8' },
]

export default function App() {
  const [mode, setMode] = useState('idle') // idle | uploading | analyzing | done | error | live
  const [uploadType, setUploadType] = useState('image')
  const [result, setResult] = useState(null)
  const [preview, setPreview] = useState(null)
  const [dragOver, setDragOver] = useState(false)
  const [selectedFrame, setSelectedFrame] = useState(0)
  const fileRef = useRef()

  // ── Live Mode state ──────────────────────────────────────────────────────────
  const [liveEvent, setLiveEvent] = useState(null)       // latest meaningful event
  const [liveCommentary, setLiveCommentary] = useState([])
  const [liveStats, setLiveStats] = useState({ runs: 0, boundaries: 0, deliveries: 0, lastSpeed: null })
  const [liveEvents, setLiveEvents] = useState([])       // all events for wagon wheel
  const [liveStatus, setLiveStatus] = useState('idle')   // idle | starting | running | stopping
  const videoRef = useRef(null)
  const canvasRef = useRef(null)
  const streamRef = useRef(null)
  const intervalRef = useRef(null)
  // ────────────────────────────────────────────────────────────────────────────

  const handleFile = useCallback(async (file) => {
    if (!file) return
    const isVideo = file.type.startsWith('video/')
    const isImage = file.type.startsWith('image/')
    if (!isVideo && !isImage) return

    const url = URL.createObjectURL(file)
    setPreview({ url, type: isVideo ? 'video' : 'image' })
    setMode('analyzing')
    setSelectedFrame(0)

    try {
      const fd = new FormData()
      fd.append('file', file)
      const endpoint = isVideo ? '/analyze/video' : '/analyze/image'
      const resp = await fetch(`${API}${endpoint}`, { method: 'POST', body: fd })
      if (!resp.ok) throw new Error('API error')
      const data = await resp.json()
      if (isVideo) {
        setResult({ type: 'video', ...data })
      } else {
        setResult({ type: 'image', frames: [data], summary: buildImageSummary(data) })
      }
      setMode('done')
    } catch {
      useDemoData(isVideo)
    }
  }, [])

  const useDemoData = async (isVideo) => {
    try {
      const endpoint = isVideo ? '/analyze/video?demo=true' : '/analyze/image?demo=true'
      const resp = await fetch(`${API}${endpoint}`, { method: 'POST', body: new FormData() })
      const data = await resp.json()
      if (isVideo) {
        setResult({ type: 'video', ...data })
      } else {
        setResult({ type: 'image', frames: [data], summary: buildImageSummary(data) })
      }
    } catch {
      setResult(getMockResult())
    }
    setMode('done')
  }

  const runDemo = async () => {
    setPreview(null)
    setMode('analyzing')
    setSelectedFrame(0)
    await useDemoData(false)
  }

  const reset = () => {
    stopLive()
    setMode('idle')
    setResult(null)
    setPreview(null)
    setSelectedFrame(0)
  }

  const onDrop = (e) => {
    e.preventDefault()
    setDragOver(false)
    handleFile(e.dataTransfer.files[0])
  }

  // ── Live Mode logic ──────────────────────────────────────────────────────────

  const startLive = async () => {
    setLiveStatus('starting')
    setLiveEvent(null)
    setLiveCommentary([])
    setLiveStats({ runs: 0, boundaries: 0, deliveries: 0, lastSpeed: null })
    setLiveEvents([])

    try {
      // Try environment camera first (mobile), fall back to any camera
      let stream
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      } catch {
        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
      }
      streamRef.current = stream
      // Switch to live mode FIRST so the <video> element mounts,
      // then useEffect below attaches the stream once the ref is ready.
      setMode('live')
      setLiveStatus('running')
    } catch (err) {
      console.error('Webcam error:', err)
      setLiveStatus('idle')
      alert('Could not access webcam. Please allow camera permissions and try again.')
    }
  }

  // Keep a ref to the latest captureAndAnalyze so setInterval never holds a stale closure
  const captureRef = useRef(null)

  const captureAndAnalyze = async () => {
    const video = videoRef.current
    const canvas = canvasRef.current

    // Guard: video must be playing and have real dimensions
    if (!video || !canvas) return
    if (video.readyState < 3) return           // HAVE_FUTURE_DATA or better
    if (video.videoWidth === 0) return          // stream not decoded yet

    // Draw frame at native video resolution (capped at 640px wide for speed)
    const vw = video.videoWidth
    const vh = video.videoHeight
    const scale = Math.min(1, 640 / vw)
    canvas.width = Math.round(vw * scale)
    canvas.height = Math.round(vh * scale)

    const ctx = canvas.getContext('2d')
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)

    // Verify we actually got pixels (not a black frame)
    const pixel = ctx.getImageData(0, 0, 1, 1).data
    if (pixel[0] === 0 && pixel[1] === 0 && pixel[2] === 0) return  // still black, skip

    const base64 = canvas.toDataURL('image/jpeg', 0.85).split(',')[1]

    try {
      const resp = await fetch(`${API}/analyze-frame`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ frame: base64 }),
      })
      if (!resp.ok) return
      const data = await resp.json()

      if (data.event === 'none') return

      setLiveEvent(data)

      if (data.commentary) {
        setLiveCommentary(prev => [data.commentary, ...prev].slice(0, 5))
      }

      setLiveEvents(prev => [...prev, data].slice(-30))

      setLiveStats(prev => {
        const bp = data.boundary_probability || 0
        const isBoundary = bp > 0.7
        const runsEst = isBoundary ? (bp > 0.85 ? 6 : 4) : (bp > 0.4 ? 2 : 1)
        return {
          runs: prev.runs + runsEst,
          boundaries: prev.boundaries + (isBoundary ? 1 : 0),
          deliveries: prev.deliveries + 1,
          lastSpeed: data.speed || data.estimated_speed_kmh || prev.lastSpeed,
        }
      })
    } catch (err) {
      console.error('Frame analysis error:', err)
    }
  }

  // Always keep the ref pointing at the latest version (avoids stale closure in setInterval)
  captureRef.current = captureAndAnalyze

  // Attach stream to <video> element after it mounts (mode === 'live')
  useEffect(() => {
    if (mode !== 'live' || !streamRef.current) return
    const video = videoRef.current
    if (!video) return

    video.srcObject = streamRef.current

    const onReady = () => {
      video.play().catch(console.error)
      // Use ref wrapper — interval always calls the latest captureAndAnalyze
      clearInterval(intervalRef.current)
      intervalRef.current = setInterval(() => captureRef.current?.(), 2000)
    }

    // onloadedmetadata fires when dimensions are known
    video.addEventListener('loadedmetadata', onReady)
    // If metadata already loaded (stream was fast), kick off immediately
    if (video.readyState >= 1) onReady()

    return () => video.removeEventListener('loadedmetadata', onReady)
  }, [mode])

  const stopLive = () => {
    clearInterval(intervalRef.current)
    intervalRef.current = null

    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop())
      streamRef.current = null
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null
    }
    setLiveStatus('idle')
  }

  // Cleanup on unmount
  useEffect(() => () => stopLive(), [])

  // ── Upload mode derived data ─────────────────────────────────────────────────
  const frame = result?.frames?.[selectedFrame] || {}
  const summary = result?.summary || {}

  const shotChartData = summary.shots_breakdown
    ? Object.entries(summary.shots_breakdown)
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([name, value]) => ({ name: name.replace(' shot', '').replace(' drive', ''), value }))
    : DEMO_SHOTS.map(d => ({ name: d.label, value: d.value }))

  const SHOT_COLORS = ['#22c55e', '#3b82f6', '#f59e0b', '#a855f7', '#ef4444', '#94a3b8']

  return (
    <div style={styles.root}>
      {/* Header */}
      <header style={styles.header}>
        <div style={styles.headerInner}>
          <div style={styles.logo}>
            <span style={styles.logoIcon}>🏏</span>
            <span style={styles.logoText}>Cricket<span style={{ color: '#22c55e' }}>IQ</span></span>
            <span style={styles.logoBadge}>AI</span>
          </div>
          <div style={styles.headerRight}>
            <span style={styles.modelBadge}>Gemini 1.5 Pro Vision</span>
            {mode === 'live' && (
              <div style={styles.liveIndicator}>
                <span style={styles.liveDot} />
                LIVE
              </div>
            )}
            {(mode === 'done' || mode === 'live') && (
              <button style={styles.resetBtn} onClick={reset}>
                <RefreshCw size={14} /> {mode === 'live' ? 'Stop & Reset' : 'New Analysis'}
              </button>
            )}
          </div>
        </div>
      </header>

      <main style={styles.main}>
        {/* ── IDLE: Upload Zone ── */}
        {mode === 'idle' && (
          <div style={styles.uploadSection}>
            <div style={styles.heroText}>
              <h1 style={styles.h1}>AI-Powered Cricket Analysis</h1>
              <p style={styles.subtitle}>Upload a match image or video — or use your camera for real-time analysis.</p>
            </div>

            <div
              style={{ ...styles.dropzone, ...(dragOver ? styles.dropzoneActive : {}) }}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
              onClick={() => fileRef.current.click()}
            >
              <input ref={fileRef} type="file" accept="image/*,video/*" style={{ display: 'none' }}
                onChange={(e) => handleFile(e.target.files[0])} />
              <div style={styles.dropzoneContent}>
                <div style={styles.uploadIconWrap}>
                  <Upload size={32} color="#22c55e" />
                </div>
                <p style={styles.dropText}>Drop image or video here</p>
                <p style={styles.dropSub}>JPG, PNG, MP4, MOV · or click to browse</p>
                <div style={styles.typeRow}>
                  <span style={styles.typeTag}><Image size={13} /> Image</span>
                  <span style={styles.typeTag}><Video size={13} /> Video</span>
                </div>
              </div>
            </div>

            <div style={styles.actionRow}>
              <button style={styles.demoBtn} onClick={runDemo}>
                <Zap size={16} /> Run Demo
              </button>
              <button
                style={styles.liveBtn}
                onClick={startLive}
                disabled={liveStatus === 'starting'}
              >
                <Radio size={16} />
                {liveStatus === 'starting' ? 'Starting...' : 'Start Live Analysis'}
              </button>
            </div>
          </div>
        )}

        {/* ── ANALYZING: Spinner ── */}
        {mode === 'analyzing' && (
          <div style={styles.analyzing}>
            <div style={styles.pulseRing} />
            <div style={styles.analyzeIcon}>🏏</div>
            <h2 style={styles.analyzeTitle}>Gemini is analyzing the match...</h2>
            <div style={styles.stepsWrap}>
              {['Extracting frames', 'Running Gemini Vision', 'Classifying shots', 'Generating commentary', 'Building stats'].map((s, i) => (
                <div key={i} style={{ ...styles.step, animationDelay: `${i * 0.4}s` }} className="step">
                  <ChevronRight size={14} color="#22c55e" /> {s}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── LIVE MODE ── */}
        {mode === 'live' && (
          <div style={styles.liveLayout}>
            {/* Left: webcam + controls */}
            <div style={styles.liveLeft}>
              <div style={styles.webcamWrap}>
                <video ref={videoRef} style={styles.webcam} autoPlay muted playsInline />
                <canvas ref={canvasRef} style={{ display: 'none' }} />
                <div style={styles.liveBadge}>
                  <span style={styles.liveDot} /> LIVE
                </div>
              </div>

              <button style={styles.stopBtn} onClick={() => { stopLive(); setMode('idle') }}>
                <StopCircle size={16} /> Stop Live
              </button>

              {/* Live stats */}
              <div style={styles.liveStatsGrid}>
                <LiveStatBox label="Deliveries" value={liveStats.deliveries} color="#22c55e" />
                <LiveStatBox label="Est. Runs" value={liveStats.runs} color="#3b82f6" />
                <LiveStatBox label="Boundaries" value={liveStats.boundaries} color="#f59e0b" />
                <LiveStatBox label="Last Speed" value={liveStats.lastSpeed ? `${liveStats.lastSpeed} km/h` : '—'} color="#a855f7" />
              </div>
            </div>

            {/* Right: event feed */}
            <div style={styles.liveRight}>
              {/* Latest event card */}
              {liveEvent ? (
                <div style={{ ...styles.card, borderColor: 'rgba(34,197,94,0.35)', marginBottom: 16 }}>
                  <div style={styles.cardHeader}>
                    <Zap size={16} color="#f59e0b" /> Latest Event
                  </div>
                  <div style={styles.shotGrid}>
                    <ShotDetail label="Shot Type" value={liveEvent.shot_type || '—'} highlight />
                    <ShotDetail label="Direction" value={liveEvent.direction || liveEvent.ball_direction || '—'} />
                    <ShotDetail label="Speed" value={liveEvent.speed || liveEvent.estimated_speed_kmh ? `~${liveEvent.speed || liveEvent.estimated_speed_kmh} km/h` : '—'} highlight />
                    <ShotDetail label="Event" value={liveEvent.event || '—'} />
                  </div>
                  {liveEvent.commentary && (
                    <p style={styles.eventDesc}>"{liveEvent.commentary}"</p>
                  )}
                </div>
              ) : (
                <div style={{ ...styles.card, textAlign: 'center', padding: 40, marginBottom: 16 }}>
                  <p style={{ color: '#64748b', fontSize: 15 }}>
                    👁️ Waiting for cricket action...<br />
                    <span style={{ fontSize: 13 }}>Point camera at match footage</span>
                  </p>
                </div>
              )}

              {/* Wagon wheel from live events */}
              {liveEvents.length > 0 && (
                <div style={{ ...styles.card, marginBottom: 16 }}>
                  <div style={styles.cardHeader}><Target size={16} color="#22c55e" /> Shot Map</div>
                  <WagonWheel frames={liveEvents} selectedIdx={liveEvents.length - 1} />
                </div>
              )}

              {/* Commentary feed */}
              {liveCommentary.length > 0 && (
                <div style={styles.card}>
                  <div style={styles.cardHeader}><Mic2 size={16} color="#22c55e" /> Commentary Feed</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {liveCommentary.map((c, i) => (
                      <div key={i} style={{
                        ...styles.commentaryLine,
                        opacity: 1 - i * 0.18,
                        borderLeftColor: i === 0 ? '#22c55e' : 'rgba(255,255,255,0.1)',
                      }}>
                        {c}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── DONE: Upload Results ── */}
        {mode === 'done' && result && (
          <div>
            <div style={styles.results}>
              {/* Left panel */}
              <div style={styles.leftPanel}>
                {preview && (
                  <div style={styles.previewCard}>
                    {preview.type === 'image'
                      ? <img src={preview.url} alt="uploaded" style={styles.previewImg} />
                      : <video src={preview.url} style={styles.previewImg} controls muted />
                    }
                    <div style={styles.previewOverlay}>
                      <span style={{ ...styles.resultLabel, background: frame.result_color || '#22c55e' }}>
                        {frame.result_label || 'Boundary'}
                      </span>
                      <span style={styles.shotBadge}>{frame.shot_type || 'Cover Drive'}</span>
                    </div>
                  </div>
                )}

                <div style={styles.card}>
                  <div style={styles.cardHeader}><Target size={16} color="#22c55e" /> Wagon Wheel</div>
                  <WagonWheel frames={result.frames} selectedIdx={selectedFrame} />
                </div>

                <CommentaryCard commentary={frame.commentary} />
              </div>

              {/* Right panel */}
              <div style={styles.rightPanel}>
                <div style={styles.statRow}>
                  <StatCard icon={<Activity size={18} color="#22c55e" />} label="Est. Runs" value={summary.estimated_runs ?? '—'} accent="#22c55e" />
                  <StatCard icon={<Wind size={18} color="#3b82f6" />} label="Avg Speed" value={`${summary.average_speed_kmh ?? frame.estimated_speed_kmh ?? '—'} km/h`} accent="#3b82f6" />
                  <StatCard icon={<Zap size={18} color="#f59e0b" />} label="Boundaries" value={summary.boundaries ?? '—'} accent="#f59e0b" />
                  <StatCard icon={<Target size={18} color="#a855f7" />} label="Strike Rate" value={summary.strike_rate ?? '—'} accent="#a855f7" />
                </div>

                <div style={styles.card}>
                  <div style={styles.cardHeader}><Zap size={16} color="#f59e0b" /> Shot Analysis</div>
                  <div style={styles.shotGrid}>
                    <ShotDetail label="Shot Type" value={frame.shot_type || '—'} highlight />
                    <ShotDetail label="Direction" value={frame.ball_direction || '—'} />
                    <ShotDetail label="Delivery" value={frame.delivery_type || '—'} />
                    <ShotDetail label="Field Zone" value={frame.field_zone || '—'} />
                    <ShotDetail label="Ball Speed" value={`~${frame.estimated_speed_kmh || '—'} km/h`} highlight />
                    <ShotDetail label="Boundary %" value={`${Math.round((frame.boundary_probability || 0) * 100)}%`} />
                    <ShotDetail label="Wicket Risk" value={frame.wicket_risk || 'low'} danger={frame.wicket_risk === 'high'} />
                    <ShotDetail label="Confidence" value={`${Math.round((frame.confidence || 0.9) * 100)}%`} />
                  </div>
                  {frame.event_description && (
                    <p style={styles.eventDesc}>"{frame.event_description}"</p>
                  )}
                </div>

                <div style={styles.card}>
                  <div style={styles.cardHeader}><BarChart3 size={16} color="#3b82f6" /> Shot Breakdown</div>
                  <ResponsiveContainer width="100%" height={180}>
                    <BarChart data={shotChartData} layout="vertical" barSize={14}>
                      <XAxis type="number" hide />
                      <YAxis type="category" dataKey="name" tick={{ fill: '#94a3b8', fontSize: 12, fontFamily: 'Space Grotesk' }} width={80} />
                      <Tooltip
                        contentStyle={{ background: '#1a2332', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, fontFamily: 'Space Grotesk' }}
                        cursor={{ fill: 'rgba(255,255,255,0.04)' }}
                      />
                      <Bar dataKey="value" radius={[0, 6, 6, 0]}>
                        {shotChartData.map((_, i) => <Cell key={i} fill={SHOT_COLORS[i % SHOT_COLORS.length]} />)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>

                {summary.key_moment && (
                  <div style={{ ...styles.card, borderColor: 'rgba(34,197,94,0.3)' }}>
                    <div style={styles.cardHeader}><Mic2 size={16} color="#22c55e" /> Key Moment</div>
                    <p style={styles.keyMoment}>{summary.key_moment}</p>
                    {summary.match_phase && (
                      <span style={styles.phaseBadge}>{summary.match_phase.toUpperCase()}</span>
                    )}
                  </div>
                )}

                {result.type === 'video' && result.frames?.length > 1 && (
                  <FrameTimeline
                    frames={result.frames}
                    selectedIdx={selectedFrame}
                    onSelect={setSelectedFrame}
                  />
                )}
              </div>
            </div>

            <div style={{ marginTop: 8 }}>
              <div style={styles.sectionLabel}>
                <MessageCircle size={15} color="#22c55e" />
                Ask the Analyst
              </div>
              <AskAnalyst analysisContext={result} />
            </div>
          </div>
        )}
      </main>

      <style>{`
        @keyframes pulse { 0%,100%{transform:scale(1);opacity:0.6} 50%{transform:scale(1.15);opacity:0.2} }
        @keyframes fadeUp { from{opacity:0;transform:translateY(10px)} to{opacity:1;transform:translateY(0)} }
        @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0.3} }
        .step { animation: fadeUp 0.4s ease both; }
      `}</style>
    </div>
  )
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function ShotDetail({ label, value, highlight, danger }) {
  return (
    <div style={styles.shotDetail}>
      <span style={styles.shotLabel}>{label}</span>
      <span style={{
        ...styles.shotValue,
        ...(highlight ? { color: '#22c55e', fontWeight: 600 } : {}),
        ...(danger ? { color: '#ef4444' } : {}),
      }}>{value}</span>
    </div>
  )
}

function LiveStatBox({ label, value, color }) {
  return (
    <div style={{ ...styles.card, textAlign: 'center', padding: '14px 10px' }}>
      <div style={{ fontSize: 22, fontWeight: 700, color }}>{value}</div>
      <div style={{ fontSize: 11, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.5px', marginTop: 4 }}>{label}</div>
    </div>
  )
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function buildImageSummary(data) {
  return {
    estimated_runs: Math.round((data.boundary_probability || 0) * 6),
    average_speed_kmh: data.estimated_speed_kmh,
    boundaries: data.boundary_probability > 0.7 ? 1 : 0,
    strike_rate: Math.round((data.boundary_probability || 0) * 150 + 50),
    shots_breakdown: { [data.shot_type || 'unknown']: 1 },
    key_moment: data.event_description,
    match_phase: 'unknown',
  }
}

function getMockResult() {
  const frame = {
    shot_type: 'cover drive', batsman_handedness: 'right-handed',
    ball_direction: 'off side', field_zone: 'cover',
    estimated_speed_kmh: 138, boundary_probability: 0.82,
    wicket_probability: 0.05, delivery_type: 'full', confidence: 0.91,
    event_description: 'Batsman elegantly drives through off side for four.',
    wagon_wheel: { x: 72, y: 38 }, result_color: '#22c55e', result_label: 'Boundary',
    wicket_risk: 'low',
    commentary: [
      'Full delivery at 138 km/h, angling into the right-hander.',
      'Batsman drives elegantly, timing perfect through the covers.',
      'FOUR! Races to the boundary — beautiful shot!'
    ]
  }
  return {
    type: 'image', frames: [frame],
    summary: {
      estimated_runs: 4, average_speed_kmh: 138, boundaries: 1, strike_rate: 133,
      shots_breakdown: { 'cover drive': 1 }, key_moment: frame.event_description, match_phase: 'powerplay'
    }
  }
}

// ── Styles ─────────────────────────────────────────────────────────────────────

const styles = {
  root: { minHeight: '100vh', background: '#0a0e17' },
  header: { borderBottom: '1px solid rgba(255,255,255,0.06)', padding: '0 24px', position: 'sticky', top: 0, zIndex: 100, background: 'rgba(10,14,23,0.95)', backdropFilter: 'blur(12px)' },
  headerInner: { maxWidth: 1400, margin: '0 auto', height: 60, display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  logo: { display: 'flex', alignItems: 'center', gap: 8 },
  logoIcon: { fontSize: 24 },
  logoText: { fontSize: 22, fontWeight: 700, letterSpacing: '-0.5px' },
  logoBadge: { background: 'rgba(34,197,94,0.15)', border: '1px solid rgba(34,197,94,0.3)', color: '#22c55e', padding: '2px 8px', borderRadius: 6, fontSize: 11, fontWeight: 600 },
  headerRight: { display: 'flex', alignItems: 'center', gap: 12 },
  modelBadge: { color: '#94a3b8', fontSize: 13, fontFamily: 'DM Mono, monospace' },
  resetBtn: { display: 'flex', alignItems: 'center', gap: 6, background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', color: '#f1f5f9', padding: '6px 14px', borderRadius: 8, fontSize: 13, cursor: 'pointer', fontFamily: 'Space Grotesk' },
  liveIndicator: { display: 'flex', alignItems: 'center', gap: 6, background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', color: '#ef4444', padding: '4px 12px', borderRadius: 20, fontSize: 13, fontWeight: 700, letterSpacing: '1px' },
  liveDot: { display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: '#ef4444', animation: 'blink 1.2s ease infinite' },
  main: { maxWidth: 1400, margin: '0 auto', padding: '40px 24px' },

  uploadSection: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 32 },
  heroText: { textAlign: 'center', maxWidth: 580 },
  h1: { fontSize: 42, fontWeight: 700, letterSpacing: '-1px', marginBottom: 12, lineHeight: 1.1 },
  subtitle: { color: '#94a3b8', fontSize: 16, lineHeight: 1.6 },

  dropzone: { width: '100%', maxWidth: 580, border: '2px dashed rgba(255,255,255,0.12)', borderRadius: 20, padding: 48, cursor: 'pointer', transition: 'all 0.2s', background: 'rgba(255,255,255,0.02)' },
  dropzoneActive: { border: '2px dashed #22c55e', background: 'rgba(34,197,94,0.05)' },
  dropzoneContent: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 },
  uploadIconWrap: { width: 64, height: 64, borderRadius: 16, background: 'rgba(34,197,94,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  dropText: { fontSize: 18, fontWeight: 600 },
  dropSub: { color: '#64748b', fontSize: 14 },
  typeRow: { display: 'flex', gap: 8, marginTop: 4 },
  typeTag: { display: 'flex', alignItems: 'center', gap: 4, background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.08)', padding: '4px 12px', borderRadius: 20, fontSize: 13, color: '#94a3b8' },

  actionRow: { display: 'flex', gap: 16, flexWrap: 'wrap', justifyContent: 'center' },
  demoBtn: { display: 'flex', alignItems: 'center', gap: 8, background: 'rgba(34,197,94,0.12)', border: '1px solid rgba(34,197,94,0.3)', color: '#22c55e', padding: '12px 28px', borderRadius: 12, fontSize: 15, fontWeight: 600, cursor: 'pointer', fontFamily: 'Space Grotesk', transition: 'all 0.2s' },
  liveBtn: { display: 'flex', alignItems: 'center', gap: 8, background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.35)', color: '#ef4444', padding: '12px 28px', borderRadius: 12, fontSize: 15, fontWeight: 600, cursor: 'pointer', fontFamily: 'Space Grotesk', transition: 'all 0.2s' },

  analyzing: { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '60vh', gap: 24, position: 'relative' },
  pulseRing: { position: 'absolute', width: 200, height: 200, borderRadius: '50%', border: '2px solid rgba(34,197,94,0.2)', animation: 'pulse 2s ease infinite' },
  analyzeIcon: { fontSize: 48 },
  analyzeTitle: { fontSize: 22, fontWeight: 600 },
  stepsWrap: { display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 },
  step: { display: 'flex', alignItems: 'center', gap: 8, color: '#94a3b8', fontSize: 14 },

  // Live mode layout
  liveLayout: { display: 'grid', gridTemplateColumns: '420px 1fr', gap: 20, alignItems: 'start' },
  liveLeft: { display: 'flex', flexDirection: 'column', gap: 14 },
  liveRight: { display: 'flex', flexDirection: 'column', gap: 0 },
  webcamWrap: { position: 'relative', borderRadius: 16, overflow: 'hidden', border: '2px solid rgba(239,68,68,0.4)', background: '#000' },
  webcam: { width: '100%', display: 'block', maxHeight: 280, objectFit: 'cover' },
  liveBadge: { position: 'absolute', top: 12, left: 12, display: 'flex', alignItems: 'center', gap: 6, background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(8px)', border: '1px solid rgba(239,68,68,0.4)', color: '#ef4444', padding: '4px 10px', borderRadius: 20, fontSize: 12, fontWeight: 700, letterSpacing: '1px' },
  stopBtn: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.35)', color: '#ef4444', padding: '10px', borderRadius: 10, fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: 'Space Grotesk' },
  liveStatsGrid: { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10 },

  commentaryLine: { fontSize: 14, color: '#94a3b8', lineHeight: 1.5, borderLeft: '3px solid', paddingLeft: 12, transition: 'opacity 0.4s' },

  // Upload results
  results: { display: 'grid', gridTemplateColumns: '400px 1fr', gap: 20, alignItems: 'start' },
  leftPanel: { display: 'flex', flexDirection: 'column', gap: 16 },
  rightPanel: { display: 'flex', flexDirection: 'column', gap: 16 },

  previewCard: { borderRadius: 16, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.08)', position: 'relative' },
  previewImg: { width: '100%', display: 'block', maxHeight: 260, objectFit: 'cover' },
  previewOverlay: { position: 'absolute', bottom: 12, left: 12, right: 12, display: 'flex', gap: 8, alignItems: 'center' },
  resultLabel: { padding: '4px 12px', borderRadius: 20, fontSize: 12, fontWeight: 700, color: '#fff' },
  shotBadge: { background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(8px)', padding: '4px 12px', borderRadius: 20, fontSize: 13, fontWeight: 600 },

  card: { background: '#111827', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 16, padding: 20 },
  cardHeader: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, fontWeight: 600, color: '#94a3b8', marginBottom: 16, textTransform: 'uppercase', letterSpacing: '0.5px' },

  statRow: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 },

  shotGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 2 },
  shotDetail: { display: 'flex', flexDirection: 'column', gap: 2, padding: '10px 0', borderBottom: '1px solid rgba(255,255,255,0.05)' },
  shotLabel: { fontSize: 11, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.5px' },
  shotValue: { fontSize: 14, fontWeight: 500, color: '#f1f5f9' },
  eventDesc: { marginTop: 14, color: '#94a3b8', fontSize: 14, lineHeight: 1.6, fontStyle: 'italic', borderLeft: '3px solid #22c55e', paddingLeft: 12 },

  keyMoment: { color: '#f1f5f9', fontSize: 15, lineHeight: 1.6, marginBottom: 12 },
  phaseBadge: { display: 'inline-block', background: 'rgba(34,197,94,0.1)', color: '#22c55e', border: '1px solid rgba(34,197,94,0.2)', padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 700, letterSpacing: '1px' },
  sectionLabel: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 10 },
}