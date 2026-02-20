import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/router';
import Head from 'next/head';
import Link from 'next/link';
import styles from './dashboard.module.css';

const PRAYER_FIELDS = [
  { key:'fajr',    label:'Fajr',     arabic:'الفجر'  },
  { key:'sunrise', label:'Sunrise',  arabic:'الشروق' },
  { key:'dhuhr',   label:'Dhuhr',    arabic:'الظهر'  },
  { key:'asr',     label:'Asr',      arabic:'العصر'  },
  { key:'maghrib', label:'Maghrib',  arabic:'المغرب' },
  { key:'isha',    label:'Isha',     arabic:'العشاء'  },
  { key:'jumuah',  label:"Jumu'ah",  arabic:'الجمعة' },
];

const MIME_TYPES = [
  'audio/wav',
  'audio/webm;codecs=opus',
  'audio/webm',
];
let MIME_TYPE = MIME_TYPES[0]; // default to WAV
if (typeof window !== 'undefined' && window.MediaRecorder) {
  MIME_TYPE = MIME_TYPES.find(m => MediaRecorder.isTypeSupported?.(m)) || MIME_TYPES[0];
  console.log('Broadcaster using MIME type for recording:', MIME_TYPE);
}

function getWsUrl() {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${window.location.host}/ws`;
}

export default function Dashboard() {
  const router = useRouter();
  const [adminUser, setAdminUser] = useState('');
  const [token,     setToken]     = useState('');

  // Prayer timings
  const [timings,  setTimings]  = useState({});
  const [saving,   setSaving]   = useState(false);
  const [saveMsg,  setSaveMsg]  = useState('');

  // Broadcast
  // states: idle | connecting | live | stopping
  const [bcastState,  setBcastState]  = useState('idle');
  const [listenerCnt, setListenerCnt] = useState(0);
  const [audioLevel,  setAudioLevel]  = useState(0);
  const [isMuted,     setIsMuted]     = useState(false);

  const wsRef       = useRef(null);
  const streamRef   = useRef(null);
  const recorderRef = useRef(null);
  const animRef     = useRef(null);
  const analyserRef = useRef(null);

  // ── Auth guard ──────────────────────────────────────────────────────────
  useEffect(() => {
    const t = localStorage.getItem('maktab_token');
    const u = localStorage.getItem('maktab_user');
    if (!t) { router.replace('/admin/login'); return; }
    setToken(t);
    setAdminUser(u || 'Admin');
    loadTimings();
  }, []);

  const authHdr = (t = token) => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${t}`,
  });

  // ── Timings ─────────────────────────────────────────────────────────────
  const loadTimings = async () => {
    try {
      const res = await fetch('/api/timings');
      if (res.ok) setTimings(await res.json());
    } catch {}
  };

  const saveTimings = async () => {
    setSaving(true); setSaveMsg('');
    try {
      const res = await fetch('/api/timings', {
        method: 'POST', headers: authHdr(), body: JSON.stringify(timings),
      });
      if (res.ok) {
        setSaveMsg('ok');
        setTimeout(() => setSaveMsg(''), 3000);
      } else if (res.status === 401) {
        logout();
      } else {
        setSaveMsg('err');
      }
    } catch { setSaveMsg('err'); }
    finally  { setSaving(false); }
  };

  // ── Visualizer ──────────────────────────────────────────────────────────
  const startViz = (stream) => {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const src = ctx.createMediaStreamSource(stream);
      const an  = ctx.createAnalyser();
      an.fftSize = 128;
      src.connect(an);
      analyserRef.current = an;
      const tick = () => {
        const d = new Uint8Array(an.frequencyBinCount);
        an.getByteTimeDomainData(d);
        const max = Math.max(...d.map(v => Math.abs(v - 128)));
        setAudioLevel(Math.min(100, (max / 128) * 260));
        animRef.current = requestAnimationFrame(tick);
      };
      tick();
    } catch {}
  };

  // ── Start broadcast ─────────────────────────────────────────────────────
  const startBroadcast = useCallback(async () => {
    if (bcastState !== 'idle') return;
    setBcastState('connecting');

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl:  false,
          sampleRate:       48000,
        }
      });
    } catch (err) {
      setBcastState('idle');
      if (err.name === 'NotAllowedError') {
        alert('Microphone access denied. Allow mic permission and try again.');
      } else {
        alert('Could not access microphone: ' + err.message);
      }
      return;
    }

    streamRef.current = stream;

    // Connect WebSocket
    const ws = new WebSocket(getWsUrl());
    wsRef.current = ws;
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      // Authenticate as transmitter
      ws.send(JSON.stringify({ type: 'transmitter', token }));
    };

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'ready') {
          // Server confirmed — start MediaRecorder
          console.log('Attempting to record with MIME type:', MIME_TYPE);
          if (!MediaRecorder.isTypeSupported(MIME_TYPE)) {
            console.error('MIME type not supported:', MIME_TYPE);
            alert('This browser does not support the required audio format. Use Chrome or Firefox.');
            stopBroadcast();
            return;
          }

          try {
            const recorder = new MediaRecorder(stream, {
              mimeType: MIME_TYPE,
              audioBitsPerSecond: 128_000,
            });
            recorderRef.current = recorder;

            recorder.ondataavailable = async (ev) => {
              if (ev.data.size > 0 && ws.readyState === WebSocket.OPEN) {
                const buf = await ev.data.arrayBuffer();
                console.log('Sending audio chunk:', buf.byteLength, 'bytes');
                ws.send(buf);
              }
            };

            recorder.onerror = (e) => {
              console.error('MediaRecorder error:', e.error);
              stopBroadcast();
            };

            // 250ms timeslice = good latency without too many messages
            recorder.start(250);
            startViz(stream);
            setBcastState('live');
            console.log('Recording started');
          } catch (e) {
            console.error('Failed to create MediaRecorder:', e);
            alert('Could not start recording: ' + e.message);
            stopBroadcast();
          }
        }
        if (msg.type === 'listener-count') {
          setListenerCnt(msg.count);
        }
        if (msg.type === 'error') {
          console.error('Server error:', msg.message);
          stopBroadcast();
        }
      } catch {}
    };

    ws.onerror = (e) => {
      console.error('WS error', e);
      stopBroadcast();
    };

    ws.onclose = () => {
      if (bcastState === 'live') stopBroadcast();
    };
  }, [bcastState, token]);

  // ── Stop broadcast ──────────────────────────────────────────────────────
  const stopBroadcast = useCallback(() => {
    setBcastState('stopping');

    // Stop recorder
    try {
      recorderRef.current?.stop();
      recorderRef.current = null;
    } catch {}

    // Stop mic tracks
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;

    // Send stop signal, close WebSocket
    try {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'stop' }));
        wsRef.current.close();
      }
    } catch {}
    wsRef.current = null;

    cancelAnimationFrame(animRef.current);
    setAudioLevel(0);
    setListenerCnt(0);
    setBcastState('idle');
  }, []);

  const toggleMute = () => {
    if (streamRef.current) {
      streamRef.current.getAudioTracks().forEach(t => { t.enabled = isMuted; });
      setIsMuted(p => !p);
    }
  };

  const logout = async () => {
    if (bcastState === 'live') stopBroadcast();
    localStorage.removeItem('maktab_token');
    localStorage.removeItem('maktab_user');
    router.push('/admin/login');
  };

  useEffect(() => () => {
    if (bcastState === 'live') stopBroadcast();
    cancelAnimationFrame(animRef.current);
  }, []);

  const isLive = bcastState === 'live';
  const bars   = Array.from({ length: 24 });

  return (
    <>
      <Head><title>Admin Dashboard — Maktab e Ahle Sunnat</title></Head>
      <div className={styles.page}>

        {/* ── Nav ── */}
        <nav className={styles.nav}>
          <div className={styles.navBrand}>
            <span className={`${styles.arabic} ${styles.navArabic}`}>مکتب اہلِ سنت</span>
            <span className={styles.navBadge}>Admin</span>
          </div>
          <div className={styles.navRight}>
            <span className={styles.navUser}>👤 {adminUser}</span>
            <Link href="/" className={styles.navBtn}>View Site ↗</Link>
            <button className={styles.logoutBtn} onClick={logout}>Logout</button>
          </div>
        </nav>

        <main className={styles.main}>
          <h1 className={styles.pageTitle}>Dashboard</h1>

          {/* ══ CARD 1 — Azan Broadcast ══ */}
          <section className={styles.card}>
            <div className={styles.cardHead}>
              <span className={styles.cardTitle}>🎙 Live Azan Broadcast</span>
              <div className={`${styles.badge} ${styles[bcastState]}`}>
                {bcastState === 'idle'       && 'Off Air'}
                {bcastState === 'connecting' && '⟳ Starting…'}
                {bcastState === 'live'       && `● LIVE · ${listenerCnt} listener${listenerCnt!==1?'s':''}`}
                {bcastState === 'stopping'   && '⟳ Stopping…'}
              </div>
            </div>
            <p className={styles.cardDesc}>
              Broadcast Azan live from your microphone. All visitors auto-receive via WebSocket audio streaming.
              Latency ≈ 300–600ms.
            </p>

            {/* Visualizer */}
            <div className={`${styles.vizBox} ${isLive?styles.vizLive:''}`}>
              {isLive ? (
                <div className={styles.vizBars}>
                  {bars.map((_,i) => (
                    <div key={i} className={styles.vizBar}
                      style={{
                        height: `${Math.max(4, audioLevel*(0.12+Math.abs(Math.sin(i*0.6))*0.88))}%`,
                        opacity: isMuted ? 0.2 : 0.88,
                      }} />
                  ))}
                </div>
              ) : (
                <div className={styles.vizIdle}>
                  {bcastState === 'connecting'
                    ? 'Connecting… allow microphone access'
                    : 'Press Start Broadcast to go live'}
                </div>
              )}
            </div>

            {/* Controls */}
            <div className={styles.controls}>
              {bcastState === 'idle' && (
                <button className={styles.startBtn} onClick={startBroadcast}>
                  ▶ &nbsp;Start Broadcast
                </button>
              )}
              {bcastState === 'connecting' && (
                <button className={styles.startBtn} disabled>
                  <span className={styles.spin} /> Starting…
                </button>
              )}
              {isLive && (<>
                <button className={`${styles.muteBtn} ${isMuted?styles.mutedOn:''}`} onClick={toggleMute}>
                  {isMuted ? '🔇 Muted — Click to Unmute' : '🎙 Live — Click to Mute'}
                </button>
                <button className={styles.stopBtn} onClick={stopBroadcast}>⏹ Stop</button>
              </>)}
              {bcastState === 'stopping' && (
                <button className={styles.stopBtn} disabled>
                  <span className={styles.spin} /> Stopping…
                </button>
              )}
            </div>

            {isLive && (
              <div className={styles.liveNote}>
                🟢 Streaming via WebSocket — all visitors are listening
              </div>
            )}
          </section>

          {/* ══ CARD 2 — Prayer Timings ══ */}
          <section className={styles.card}>
            <div className={styles.cardHead}>
              <span className={styles.cardTitle}>🕌 Prayer Timings</span>
            </div>
            <p className={styles.cardDesc}>Set the daily prayer times shown on the homepage.</p>

            <div className={styles.timingsList}>
              {PRAYER_FIELDS.map(({ key, label, arabic }) => (
                <div key={key} className={styles.tRow}>
                  <div className={styles.tLabel}>
                    <span className={`${styles.arabic} ${styles.tArabic}`}>{arabic}</span>
                    <span className={styles.tEn}>{label}</span>
                  </div>
                  <input
                    type="time"
                    className={styles.tInput}
                    value={timings[key] || ''}
                    onChange={e => setTimings(p => ({ ...p, [key]: e.target.value }))}
                  />
                </div>
              ))}
            </div>
          </section>

          {/* ══ CARD 3 — Ramadan Timings ══ */}
          <section className={styles.card}>
            <div className={styles.cardHead}>
              <span className={styles.cardTitle}>🌙 Ramadan Timings</span>
            </div>
            <p className={styles.cardDesc}>Toggle Sehri &amp; Iftar display on homepage during Ramadan.</p>

            <div className={styles.tRow} style={{ marginBottom:'1rem' }}>
              <span className={styles.tEn}>Show Ramadan timings on homepage</span>
              <button
                className={`${styles.toggle} ${timings.showRamadan ? styles.toggleOn : ''}`}
                onClick={() => setTimings(p => ({ ...p, showRamadan: !p.showRamadan }))}
              >
                <span className={styles.toggleThumb} />
              </button>
            </div>

            <div className={styles.timingsList}>
              {[
                { key:'sehri', label:'Sehri ends', arabic:'سحری' },
                { key:'iftar', label:'Iftar time',  arabic:'افطار' },
              ].map(({ key, label, arabic }) => (
                <div key={key} className={styles.tRow}>
                  <div className={styles.tLabel}>
                    <span className={`${styles.arabic} ${styles.tArabic}`}>{arabic}</span>
                    <span className={styles.tEn}>{label}</span>
                  </div>
                  <input
                    type="time"
                    className={styles.tInput}
                    value={timings[key] || ''}
                    onChange={e => setTimings(p => ({ ...p, [key]: e.target.value }))}
                  />
                </div>
              ))}
            </div>
          </section>

          {/* ── Save row ── */}
          <div className={styles.saveRow}>
            {saveMsg === 'ok'  && <span className={styles.msgOk}>✓ Saved successfully</span>}
            {saveMsg === 'err' && <span className={styles.msgErr}>✗ Failed to save</span>}
            <button className={styles.saveBtn} onClick={saveTimings} disabled={saving}>
              {saving ? <><span className={styles.spin}/> Saving…</> : '💾 Save All Timings'}
            </button>
          </div>
        </main>
      </div>
    </>
  );
}
