import { signToken } from '../../../lib/auth';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { username, password } = req.body || {};
  const validUser = process.env.ADMIN_USERNAME || 'admin';
  const validPass = process.env.ADMIN_PASSWORD || 'maktab2024';

  if (username === validUser && password === validPass) {
    const token = await signToken({ role: 'admin', username });
    return res.status(200).json({ token, username });
  }

  return res.status(401).json({ error: 'Invalid credentials' });
}
