import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import Head from 'next/head';
import Link from 'next/link';
import styles from './login.module.css';

export default function AdminLogin() {
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error,    setError]    = useState('');
  const [loading,  setLoading]  = useState(false);

  useEffect(() => {
    if (localStorage.getItem('maktab_token')) router.replace('/admin/dashboard');
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(''); setLoading(true);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (res.ok) {
        const { token, username: u } = await res.json();
        localStorage.setItem('maktab_token', token);
        localStorage.setItem('maktab_user',  u);
        router.push('/admin/dashboard');
      } else {
        setError('Invalid username or password');
      }
    } catch {
      setError('Server error. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <Head><title>Admin Login — Maktab e Ahle Sunnat</title></Head>
      <div className={styles.page}>
        <Link href="/" className={styles.backLink}>← Prayer Timings</Link>
        <div className={styles.card}>
          <div className={styles.moon}>☽</div>
          <div className={styles.arabic} style={{ fontSize:'1.3rem', color:'var(--gold-dim)', textAlign:'center' }}>لاگ ان</div>
          <h1 className={styles.title}>Admin Login</h1>
          <p className={styles.sub}>Maktab e Ahle Sunnat</p>
          <div className={styles.rule} />
          <form onSubmit={handleSubmit} className={styles.form}>
            <label className={styles.label}>Username</label>
            <input className={styles.input} type="text" value={username}
              onChange={e=>setUsername(e.target.value)} placeholder="admin" autoComplete="username" required />
            <label className={styles.label}>Password</label>
            <input className={styles.input} type="password" value={password}
              onChange={e=>setPassword(e.target.value)} placeholder="••••••••" autoComplete="current-password" required />
            {error && <div className={styles.error}>{error}</div>}
            <button className={styles.btn} type="submit" disabled={loading}>
              {loading ? <><span className={styles.spin} /> Verifying…</> : 'Login to Dashboard'}
            </button>
          </form>
        </div>
      </div>
    </>
  );
}
