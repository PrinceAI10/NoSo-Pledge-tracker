import { kv } from '@vercel/kv';

const LIST_KEY = 'noso:pledges';
const MAX_NAME_LEN = 60;
const MAX_DURATION_LEN = 60;

export default async function handler(req, res) {
  if (req.method === 'GET') {
    try {
      const pledges = (await kv.lrange(LIST_KEY, 0, -1)) || [];
      return res.status(200).json(pledges);
    } catch (err) {
      return res.status(500).json({ error: 'Failed to load pledges' });
    }
  }

  if (req.method === 'POST') {
    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      const type = body?.type;
      if (type !== 'Deep Reset' && type !== 'Reclaim Window') {
        return res.status(400).json({ error: 'Invalid pledge type' });
      }
      const name = String(body?.name || 'Anonymous').slice(0, MAX_NAME_LEN);
      const duration = String(body?.duration || '').slice(0, MAX_DURATION_LEN);

      const pledge = {
        id: 'p_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
        name,
        type,
        duration,
        ts: Date.now()
      };

      // Push newest first, cap the stored list so it can't grow unbounded.
      await kv.lpush(LIST_KEY, pledge);
      await kv.ltrim(LIST_KEY, 0, 999);

      return res.status(200).json({ ok: true, pledge });
    } catch (err) {
      return res.status(500).json({ error: 'Failed to save pledge' });
    }
  }

  res.setHeader('Allow', ['GET', 'POST']);
  return res.status(405).end('Method Not Allowed');
}
