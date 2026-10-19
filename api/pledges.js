import { kv } from '@vercel/kv';
import { Resend } from 'resend';
import emailjs from '@emailjs/nodejs';

const LIST_KEY = 'noso:pledges';
const MAX_NAME_LEN = 60;
const MAX_DURATION_LEN = 60;
const MAX_EMAIL_LEN = 254;
const MAX_COUNTRY_LEN = 60;
const MAX_REASON_LEN = 120;
const MAX_PLATFORMS_LEN = 150;

const WHATSAPP_LINK = 'https://whatsapp.com/channel/0029VbDnhhLCnA7lR8Km6i1i';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_KEY = process.env.ADMIN_KEY;
const FROM_ADDRESS = process.env.RESEND_FROM || 'NoSo November <onboarding@resend.dev>';

const resend = new Resend(process.env.RESEND_API_KEY);

const isValidEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || ''));

function formatDate(ts) {
  try {
    return new Date(ts).toLocaleString('en-GB', {
      dateStyle: 'medium', timeStyle: 'short', timeZone: 'GMT'
    }) + ' GMT';
  } catch {
    return new Date(ts).toISOString();
  }
}

async function sendEmails(pledge) {
  const jobs = [];

  // --- 1. PLEDGER EMAIL via EMAILJS ---
  jobs.push(
    emailjs.send(
      process.env.EMAILJS_SERVICE_ID,
      process.env.EMAILJS_TEMPLATE_ID,
      {
        to_email: pledge.email,
        name: pledge.name,
        type: pledge.type,
        duration: pledge.duration || '-',
        whatsapp_link: WHATSAPP_LINK
      },
      {
        publicKey: process.env.EMAILJS_PUBLIC_KEY,
        privateKey: process.env.EMAILJS_PRIVATE_KEY
      }
    )
  );

  // --- 2. ADMIN EMAIL via RESEND ---
  if (ADMIN_EMAIL && process.env.RESEND_API_KEY) {
    const adminHtml = `
      <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#1a1721;">
        <div style="background:#5a3b94;color:#fff;padding:14px 18px;border-radius:10px 10px 0 0;">
          <strong style="font-size:16px;">New NoSo Pledge</strong>
        </div>
        <div style="border:1px solid #e7e3f0;border-top:none;border-radius:0 0 10px 10px;padding:18px;">
          <p style="margin:0 0 12px;">A new pledge just came in:</p>
          <p style="margin:0 0 8px;"><strong>Name:</strong> ${pledge.name}</p>
          <p style="margin:0 0 8px;"><strong>Email:</strong> ${pledge.email}</p>
          <p style="margin:0 0 8px;"><strong>Country:</strong> ${pledge.country || '-'}</p>
          <p style="margin:0 0 8px;"><strong>Pledge:</strong> ${pledge.type}</p>
          <p style="margin:0 0 8px;"><strong>Platforms:</strong> ${pledge.platforms || '-'}</p>
          <p style="margin:0 0 8px;"><strong>Duration:</strong> ${pledge.duration || '-'}</p>
          <p style="margin:0 0 8px;"><strong>Reason:</strong> ${pledge.reason || '-'}</p>
          <p style="margin:0 0 8px;"><strong>Time:</strong> ${formatDate(pledge.ts)}</p>
        </div>
      </div>`;

    jobs.push(
      resend.emails.send({
        from: FROM_ADDRESS,
        to: ADMIN_EMAIL,
        subject: `New pledge: ${pledge.name} (${pledge.type})`,
        html: adminHtml,
        replyTo: pledge.email
      })
    );
  }

  const results = await Promise.allSettled(jobs);
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.error(`[email] send ${i} failed:`, r.reason?.message || r.reason);
    }
  });
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    try {
      const stored = (await kv.lrange(LIST_KEY, 0, -1)) || [];
      const publicPledges = stored.map(({ email, ...p }) => p);
      return res.status(200).json(publicPledges);
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

      const email = String(body?.email || '').trim().slice(0, MAX_EMAIL_LEN);
      if (!isValidEmail(email)) {
        return res.status(400).json({ error: 'A valid email is required' });
      }

      const name = String(body?.name || 'Anonymous').slice(0, MAX_NAME_LEN);
      const duration = String(body?.duration || '').slice(0, MAX_DURATION_LEN);
      const country = String(body?.country || '').slice(0, MAX_COUNTRY_LEN);
      const reason = String(body?.reason || '').slice(0, MAX_REASON_LEN);
      const platforms = String(body?.platforms || '').slice(0, MAX_PLATFORMS_LEN);

      const pledge = {
        id: 'p_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
        name,
        email,
        country,
        type,
        platforms,
        duration,
        reason,
        ts: Date.now()
      };

      await kv.lpush(LIST_KEY, pledge);
      await kv.ltrim(LIST_KEY, 0, 999);

      sendEmails(pledge).catch(err =>
        console.error('[email] sendEmails failed:', err?.message || err)
      );

      const { email: _email, ...publicPledge } = pledge;
      return res.status(200).json({ ok: true, pledge: publicPledge });
    } catch (err) {
      return res.status(500).json({ error: 'Failed to save pledge' });
    }
  }

  if (req.method === 'DELETE') {
    try {
      if (!ADMIN_KEY) {
        return res.status(500).json({ error: 'Admin deletion is not configured' });
      }

      const providedKey = req.headers['x-admin-key'];
      if (!providedKey || providedKey !== ADMIN_KEY) {
        return res.status(401).json({ error: 'Invalid admin passcode' });
      }

      const id = req.query?.id;
      if (!id) {
        return res.status(400).json({ error: 'Missing pledge id' });
      }

      const stored = (await kv.lrange(LIST_KEY, 0, -1)) || [];
      const match = stored.find((p) => p.id === id);
      if (!match) {
        return res.status(404).json({ error: 'Pledge not found' });
      }

      await kv.lrem(LIST_KEY, 0, match);
      return res.status(200).json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: 'Failed to delete pledge' });
    }
  }

  res.setHeader('Allow', ['GET', 'POST', 'DELETE']);
  return res.status(405).end('Method Not Allowed');
}