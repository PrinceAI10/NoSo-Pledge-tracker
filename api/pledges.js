import { kv } from '@vercel/kv';
import { Resend } from 'resend';
import emailjs from '@emailjs/nodejs';

const LIST_KEY = 'noso:pledges';
const MAX_NAME_LEN = 60;
const MAX_DURATION_LEN = 60;
const MAX_EMAIL_LEN = 254;

const WHATSAPP_LINK = 'https://whatsapp.com/channel/0029VbDnhhLCnA7lR8Km6i1i';

const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
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

  // 1. PLEDGER EMAIL via EMAILJS
  jobs.push(
    emailjs.send(
      process.env.EMAILJS_SERVICE_ID,
      process.env.EMAILJS_TEMPLATE_ID,
      {
        to_email: pledge.email,
        name: pledge.name,
        type: pledge.type,
        duration: pledge.duration || '-'
      },
      {
        publicKey: process.env.EMAILJS_PUBLIC_KEY,
        privateKey: process.env.EMAILJS_PRIVATE_KEY
      }
    )
  );

  // 2. ADMIN EMAIL via RESEND
  if (ADMIN_EMAIL && process.env.RESEND_API_KEY) {
    const adminHtml = `
      <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#1a1721;">
        <div style="background:#5a3b94;color:#fff;padding:14px 18px;border-radius:10px 10px 0 0;">
          <strong style="font-size:16px;">New NoSo Pledge</strong>
        </div>
        <div style="border:1px solid #e7e3f0;border-top:none;border-radius:0 0 10px 10px;padding:18px;">
          <p style="margin:0 0 12px;">A new pledge just came in:</p>
          <p style="margin:0 0 8px;"><strong>Name:</strong> ${pledge.name}</p>
          <p style="margin:0 0 8px;"><strong>Pledge:</strong> ${pledge.type}</p>
          <p style="margin:0 0 8px;"><strong>Duration:</strong> ${pledge.duration || '-'}</p>
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

      const pledge = {
        id: 'p_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
        name,
        email,
        type,
        duration,
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

  res.setHeader('Allow', ['GET', 'POST']);
  return res.status(405).end('Method Not Allowed');
}