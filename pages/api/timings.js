import { requireAdmin } from '../../lib/auth';

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json(global.__maktabTimings || {});
  }

  if (req.method === 'POST') {
    const admin = await requireAdmin(req);
    if (!admin) return res.status(401).json({ error: 'Unauthorized' });

    global.__maktabTimings = {
      ...global.__maktabTimings,
      ...req.body,
      updatedAt: new Date().toISOString(),
    };
    return res.status(200).json(global.__maktabTimings);
  }

  return res.status(405).end();
}
