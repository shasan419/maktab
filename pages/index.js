import { useState, useEffect, useRef, useCallback } from 'react';
import Head from 'next/head';
import Link from 'next/link';
import styles from './index.module.css';

// ── Constants ─────────────────────────────────────────────────────────────────
const POLL_MS      = 4000;   // how often to check connection health
const RETRY_MS     = 3000;   // reconnect delay after disconnect

const PRAYERS = [
  { key: 'fajr',    label: 'Fajr',     arabic: 'الفجر',  icon: '🌙' },
  { key: 'sunrise', label: 'Sunrise',  arabic: 'الشروق', icon: '🌅' },
  { key: 'dhuhr',   label: 'Dhuhr',    arabic: 'الظهر',  icon: '☀️'  },
  { key: 'asr',     label: 'Asr',      arabic: 'العصر',  icon: '🌤'  },
  { key: 'maghrib', label: 'Maghrib',  arabic: 'المغرب', icon: '🌇'  },
  { key: 'isha',    label: 'Isha',     arabic: 'العشاء', icon: '🌃'  },
  { key: 'jumuah',  label: "Jumu'ah",  arabic: 'الجمعة', icon: '🕌'  },
];

function fmt12(t) {
  if (!t) return '--:--';
  const [h, m] = t.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2,'0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

function getNextPrayer(timings) {
  const now  = new Date();
  const mins = now.getHours() * 60 + now.getMinutes();
  for (const k of ['fajr','dhuhr','asr','maghrib','isha']) {
    if (!timings[k]) continue;
    const [h,m] = timings[k].split(':').map(Number);
    if (h * 60 + m > mins) return k;
  }
  return 'fajr';
}

function getWsUrl() {
  if (typeof window === 'undefined') return '';
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${window.location.host}/ws`;
}

// ── Simple audio player using blob accumulation ──────────────────────────────
class AudioStreamer {
  constructor(audioCtx) {
    this.chunks = [];
    this.audio = null;
    this.audioCtx = audioCtx;
  }

  init(audioEl) {
    this.audio = audioEl;
    console.log('Audio streamer initialized');
    return true;
  }

  resumeContext() {
    if (this.audioCtx?.state === 'suspended') {
      console.log('Resuming audio context');
      this.audioCtx.resume();
    }
  }

  push(arrayBuffer) {
    if (!this.audio) {
      console.warn('Audio element not ready');
      return;
    }
    
    this.chunks.push(new Uint8Array(arrayBuffer));
    const total = this.chunks.reduce((a, c) => a + c.length, 0);
    console.log('Queued chunk:', arrayBuffer.byteLength, 'bytes (total:', total, 'bytes)');
    
    // Only update audio source when we have a reasonable amount of data
    // For WebM, we need at least one complete frame/cluster
    if (total > 10000) {
      this._updateAudioSource();
    }
  }

  _updateAudioSource() {
    try {
      // For streaming audio, just use all accumulated chunks as-is
      // This works best with continuous single-file encoding (no timeslices)
      const totalLength = this.chunks.reduce((a, c) => a + c.length, 0);
      const combined = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of this.chunks) {
        combined.set(chunk, offset);
        offset += chunk.length;
      }
      
      const blob = new Blob([combined], { type: 'audio/webm' });
      const url = URL.createObjectURL(blob);
      
      // Only set src if it changed
      if (this.audio.src !== url) {
        console.log('Setting audio source:', totalLength, 'bytes');
        this.audio.src = url;
      }
    } catch (e) {
      console.error('Error updating audio source:', e);
    }
  }

  _updateAudioSource() {
    try {
      // Combine all chunks into one blob
      const totalLength = this.chunks.reduce((a, c) => a + c.length, 0);
      const combined = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of this.chunks) {
        combined.set(chunk, offset);
        offset += chunk.length;
      }
      
      const blob = new Blob([combined], { type: 'audio/webm;codecs=opus' });
      const url = URL.createObjectURL(blob);
      
      if (this.audio.src !== url) {
        console.log('Updating audio source with', totalLength, 'bytes');
        this.audio.src = url;
        
        // Try to play if we have enough data (at least 50KB)
        if (totalLength > 50000 && this.audio.paused) {
          console.log('Attempting to play audio...');
          this.audio.play().catch(err => {
            console.warn('Autoplay blocked or failed:', err.message);
          });
        }
      }
    } catch (e) {
      console.error('Error updating audio source:', e);
    }
  }

  getLevel() {
    if (!this.audioCtx?.analyser) return 0;
    const d = new Uint8Array(this.audioCtx.analyser.frequencyBinCount);
    this.audioCtx.analyser.getByteTimeDomainData(d);
    const max = Math.max(...d.map(v => Math.abs(v - 128)));
    return Math.min(100, (max / 128) * 260);
  }

  destroy() {
    console.log('Destroying AudioStreamer');
    this.chunks = [];
    
    if (this.audio?.src) {
      try {
        URL.revokeObjectURL(this.audio.src);
      } catch {}
      this.audio.src = '';
      this.audio.pause();
    }

    this.audio = null;
  }
}

// ── Component ─────────────────────────────────────────────────────────────────
export default function Home() {
  const [timings,      setTimings]      = useState(null);
  const [now,          setNow]          = useState(null);
  const [nextPrayer,   setNextPrayer]   = useState('');

  // Azan states: idle | connecting | live | error
  const [azanState,    setAzanState]    = useState('idle');
  const [isBroadcast,  setIsBroadcast]  = useState(false);
  const [volume,       setVolume]       = useState(90);
  const [isMuted,      setIsMuted]      = useState(false);
  const [audioLevel,   setAudioLevel]   = useState(0);
  const [wsReady,      setWsReady]      = useState(false);

  const wsRef        = useRef(null);
  const audioRef     = useRef(null);
  const streamerRef  = useRef(null);
  const retryRef     = useRef(null);
  const animRef      = useRef(null);
  const audioCtxRef  = useRef(null);
  const hasInteracted = useRef(false);

  // ── Clock ────────────────────────────────────────────────────────────────
  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  // ── Initialize audio context once on mount ──────────────────────────────
  useEffect(() => {
    if (typeof window === 'undefined' || audioCtxRef.current) return;

    try {
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioRef.current) {
        const src = audioCtx.createMediaElementSource(audioRef.current);
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 128;
        src.connect(analyser);
        analyser.connect(audioCtx.destination);
        audioCtx.analyser = analyser;
        audioCtxRef.current = audioCtx;
        console.log('Audio context created and ready');
      }
    } catch (e) {
      console.warn('Audio context setup failed:', e);
    }
  }, []);

  // ── Sync volume and muted state to audio element ─────────────────────────
  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.volume = volume / 100;
      audioRef.current.muted = isMuted;
    }
  }, [volume, isMuted]);

  useEffect(() => {
    if (timings) setNextPrayer(getNextPrayer(timings));
  }, [timings, now?.getMinutes()]);

  // ── Fetch prayer timings ─────────────────────────────────────────────────
  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch('/api/timings');
        if (res.ok) setTimings(await res.json());
      } catch {}
    };
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, []);

  // ── Track user interaction (needed for autoplay) ─────────────────────────
  useEffect(() => {
    const mark = () => { hasInteracted.current = true; };
    window.addEventListener('click',     mark, { once: true, capture: true });
    window.addEventListener('touchstart',mark, { once: true, capture: true });
    return () => {
      window.removeEventListener('click',     mark, true);
      window.removeEventListener('touchstart',mark, true);
    };
  }, []);

  // ── Visualizer tick ──────────────────────────────────────────────────────
  const startVizTick = useCallback(() => {
    const tick = () => {
      if (streamerRef.current) {
        setAudioLevel(streamerRef.current.getLevel());
      }
      animRef.current = requestAnimationFrame(tick);
    };
    animRef.current = requestAnimationFrame(tick);
  }, []);

  // ── Init/start audio player ──────────────────────────────────────────────
  const initStreamer = useCallback(() => {
    if (!audioRef.current) {
      console.error('Audio element not available');
      return false;
    }

    // Destroy old streamer
    if (streamerRef.current) {
      console.log('Destroying old streamer');
      streamerRef.current.destroy();
      streamerRef.current = null;
    }

    // Small delay to ensure old streamer is cleaned up
    setTimeout(() => {
      try {
        const s = new AudioStreamer(audioCtxRef.current);
        const ok = s.init(audioRef.current);
        if (ok) {
          streamerRef.current = s;
          console.log('New streamer initialized');
        } else {
          console.error('AudioStreamer init failed');
        }
      } catch (e) {
        console.error('Failed to create new AudioStreamer:', e);
      }
    }, 100);

    return true;
  }, []);

  const startPlaying = useCallback(() => {
    initStreamer();
    
    // Wait for streamer to be initialized
    setTimeout(() => {
      if (!streamerRef.current) {
        console.error('Streamer initialization failed');
        setAzanState('error');
        return;
      }

      if (audioRef.current) {
        console.log('Audio element state:', {
          paused: audioRef.current.paused,
          src: audioRef.current.src ? 'set' : 'empty',
          volume: audioRef.current.volume,
          muted: audioRef.current.muted,
          autoplay: audioRef.current.autoplay
        });
      }

      streamerRef.current.resumeContext();
      setAzanState('live');
      startVizTick();
      console.log('Listening mode activated, waiting for audio source...');
    }, 150);
  }, [initStreamer, startVizTick]);

  const stopPlaying = useCallback(() => {
    cancelAnimationFrame(animRef.current);
    streamerRef.current?.destroy();
    streamerRef.current = null;
    setAudioLevel(0);
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = '';
    }
    setAzanState('idle');
  }, []);

  // ── Connect WebSocket ────────────────────────────────────────────────────
  const connectWs = useCallback(() => {
    if (wsRef.current?.readyState <= 1) return; // already open/connecting
    clearTimeout(retryRef.current);

    const url = getWsUrl();
    if (!url) return;

    const ws = new WebSocket(url);
    wsRef.current = ws;
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      setWsReady(true);
      ws.send(JSON.stringify({ type: 'listener' }));
    };

    ws.onmessage = (e) => {
      // ── JSON control message ──
      if (typeof e.data === 'string') {
        let msg;
        try { msg = JSON.parse(e.data); } catch { return; }

        if (msg.type === 'broadcast-start') {
          setIsBroadcast(true);
          // Auto-play if user has already interacted
          if (hasInteracted.current) {
            startPlaying();
          } else {
            setAzanState('idle'); // show banner with manual "Listen" button
          }
        }

        if (msg.type === 'broadcast-end') {
          setIsBroadcast(false);
          stopPlaying();
        }

        return;
      }

      // ── Binary audio chunk → push to streamer ──
      if (e.data instanceof ArrayBuffer) {
        if (streamerRef.current) {
          streamerRef.current.push(e.data);
        }
        return;
      }
    };

    ws.onclose = () => {
      setWsReady(false);
      // Reconnect after delay
      retryRef.current = setTimeout(connectWs, RETRY_MS);
    };

    ws.onerror = () => {
      ws.close();
    };
  }, [startPlaying, stopPlaying]);

  // Mount WS connection
  useEffect(() => {
    connectWs();
    return () => {
      clearTimeout(retryRef.current);
      wsRef.current?.close();
      stopPlaying();
    };
  }, []); // eslint-disable-line

  // ── Manual listen (after user taps "Listen") ─────────────────────────────
  const handleListenClick = () => {
    hasInteracted.current = true;
    startPlaying();
  };

  // ── Volume / mute ────────────────────────────────────────────────────────
  const handleVolume = (e) => {
    const v = Number(e.target.value);
    setVolume(v);
    if (audioRef.current) audioRef.current.volume = v / 100;
  };

  const toggleMute = () => {
    const next = !isMuted;
    setIsMuted(next);
    if (audioRef.current) audioRef.current.muted = next;
    streamerRef.current?.resumeContext();
  };

  // ── Render ───────────────────────────────────────────────────────────────
  const timeStr = now ? now.toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit', second:'2-digit' }) : '--:--:--';
  const dateStr = now ? now.toLocaleDateString('en-GB',  { weekday:'long', day:'numeric', month:'long', year:'numeric' }) : '';
  const bars    = Array.from({ length: 26 });

  return (
    <>
      <Head><title>Maktab e Ahle Sunnat — Prayer Timings</title></Head>

      <div className={styles.page}>

        {/* ── Header ── */}
        <header className={styles.header}>
          <div className={styles.headerRow}>
            <div className={styles.arabic} style={{ fontSize:'1.5rem', color:'var(--gold-dim)' }}>
              مکتب اہلِ سنت
            </div>
            <Link href="/admin/login" className={styles.adminBtn}>⚙ Admin</Link>
          </div>
          <h1 className={styles.siteName}>Maktab e Ahle Sunnat</h1>
          <div className={styles.tagline}>
            <span className={styles.gem}>✦</span>
            <span>Prayer Timings &amp; Live Azan</span>
            <span className={styles.gem}>✦</span>
          </div>
        </header>

        {/* ── Live Clock ── */}
        <section className={styles.clockCard}>
          <div className={styles.clock}>{timeStr}</div>
          <div className={styles.date}>{dateStr}</div>
          {/* WebSocket connection dot */}
          <div className={styles.connRow}>
            <span className={`${styles.connDot} ${wsReady ? styles.connOk : styles.connOff}`} />
            <span className={styles.connLabel}>{wsReady ? 'Connected' : 'Connecting…'}</span>
          </div>
        </section>

        {/* ── Azan Live Banner ── */}
        {isBroadcast && azanState !== 'live' && (
          <div className={styles.azanBanner} onClick={handleListenClick}>
            <div className={styles.bannerLeft}>
              <span className={styles.liveDot} />
              <div>
                <div className={styles.bannerTitle}>Azan is Live</div>
                <div className={styles.bannerSub}>Tap anywhere on this bar to listen</div>
              </div>
            </div>
            <button className={styles.listenBtn}>▶ Listen</button>
          </div>
        )}

        {/* ── Audio Visualizer (while live) ── */}
        {azanState === 'live' && (
          <div className={styles.playerCard}>
            <div className={styles.playerHeader}>
              <div className={styles.liveChip}>
                <span className={styles.liveDotRed} />
                LIVE AZAN
              </div>
              <span className={styles.arabic} style={{ fontSize:'1.3rem', color:'var(--gold)' }}>
                اللَّهُ أَكْبَر
              </span>
            </div>

            <div className={styles.visualizer}>
              {bars.map((_, i) => (
                <div
                  key={i}
                  className={styles.vBar}
                  style={{
                    height: `${Math.max(4, audioLevel * (0.15 + Math.abs(Math.sin(i*0.6)) * 0.85))}%`,
                    opacity: isMuted ? 0.2 : 0.9,
                  }}
                />
              ))}
            </div>

            <div className={styles.playerControls}>
              <button className={`${styles.muteBtn} ${isMuted ? styles.mutedOn : ''}`} onClick={toggleMute}>
                {isMuted ? '🔇' : '🔊'}
              </button>
              <input
                type="range" min="0" max="100" value={volume}
                onChange={handleVolume} className={styles.volSlider}
              />
              <span className={styles.volPct}>{volume}%</span>
            </div>
          </div>
        )}

        {/* ── Ramadan Timings ── */}
        {timings?.showRamadan && (
          <section className={styles.ramadanCard}>
            <div className={styles.sectionLabel}>
              <span className={styles.arabic} style={{ fontSize:'1.1rem' }}>رمضان المبارک</span>
              <span className={styles.sectionEn}>Ramadan Timings</span>
            </div>
            <div className={styles.ramGrid}>
              <div className={styles.ramItem}>
                <span className={styles.ramIcon}>🌙</span>
                <span className={styles.ramName}>Sehri ends</span>
                <span className={styles.ramTime}>{fmt12(timings.sehri)}</span>
              </div>
              <div className={`${styles.ramItem} ${styles.ramIftar}`}>
                <span className={styles.ramIcon}>🌅</span>
                <span className={styles.ramName}>Iftar</span>
                <span className={styles.ramTime}>{fmt12(timings.iftar)}</span>
              </div>
            </div>
          </section>
        )}

        {/* ── Prayer Timings ── */}
        <section className={styles.prayersSection}>
          <div className={styles.sectionLabel}>
            <span className={styles.arabic} style={{ fontSize:'1.1rem' }}>اوقاتِ نماز</span>
            <span className={styles.sectionEn}>Prayer Timings</span>
          </div>

          {!timings ? (
            <div className={styles.loading}><div className={styles.spinner} /></div>
          ) : (
            <div className={styles.prayerList}>
              {PRAYERS.map(({ key, label, arabic, icon }) => {
                const isNext = nextPrayer === key && key !== 'sunrise';
                return (
                  <div key={key} className={`${styles.pRow} ${isNext ? styles.pRowNext : ''}`}>
                    {isNext && <div className={styles.nextTag}>Next</div>}
                    <span className={styles.pIcon}>{icon}</span>
                    <div className={styles.pNames}>
                      <span className={`${styles.arabic} ${styles.pArabic}`}>{arabic}</span>
                      <span className={styles.pLabel}>{label}</span>
                    </div>
                    <span className={`${styles.pTime} ${isNext ? styles.pTimeNext : ''}`}>
                      {fmt12(timings[key])}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* ── Footer ── */}
        <footer className={styles.footer}>
          <div className={styles.arabic} style={{ color:'var(--gold-dim)', fontSize:'1rem' }}>
            بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ
          </div>
          {timings?.updatedAt && (
            <p className={styles.footerNote}>
              Updated: {new Date(timings.updatedAt).toLocaleString('en-GB')}
            </p>
          )}
        </footer>
      </div>

      {/* Hidden audio element */}
      <audio ref={audioRef} autoPlay playsInline style={{ display:'none' }} />
    </>
  );
}
