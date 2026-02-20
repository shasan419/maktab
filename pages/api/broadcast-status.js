export default function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  const state = global.__maktabBroadcast || { isLive: false, listenerCount: 0 };
  res.status(200).json(state);
}
