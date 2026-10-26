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

const WHATSAPP_LINK =
  'https://whatsapp.com/channel/0029VbDnhhLCnA7lR8Km6i1i';

const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_KEY = process.env.ADMIN_KEY;

const FROM_ADDRESS =
  process.env.RESEND_FROM ||
  'NoSo November <onboarding@resend.dev>';

const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

const isValidEmail = (value) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || ''));

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => {
    const entities = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };

    return entities[char];
  });
}

function formatDate(timestamp) {
  try {
    return (
      new Date(timestamp).toLocaleString('en-GB', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: 'UTC',
      }) + ' GMT'
    );
  } catch {
    return new Date(timestamp).toISOString();
  }
}

async function sendEmails(pledge) {
  const jobs = [];

  // 1. Confirmation email to the pledger via EmailJS.
  if (
    process.env.EMAILJS_SERVICE_ID &&
    process.env.EMAILJS_TEMPLATE_ID &&
    process.env.EMAILJS_PUBLIC_KEY &&
    process.env.EMAILJS_PRIVATE_KEY
  ) {
    jobs.push(
      emailjs.send(
        process.env.EMAILJS_SERVICE_ID,
        process.env.EMAILJS_TEMPLATE_ID,
        {
          to_email: pledge.email,
          name: pledge.name,
          type: pledge.type,
          duration: pledge.duration || '-',
          whatsapp_link: WHATSAPP_LINK,
        },
        {
          publicKey: process.env.EMAILJS_PUBLIC_KEY,
          privateKey: process.env.EMAILJS_PRIVATE_KEY,
        }
      )
    );
  } else {
    console.error(
      '[email] EmailJS is not fully configured. Pledger email skipped.'
    );
  }

  // 2. Notification email to the administrator via Resend.
  if (ADMIN_EMAIL && resend) {
    const adminHtml = `
      <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#382052;background:#ffffff;">
        <div style="background:#5a3b94;color:#ffffff;padding:16px 20px;border-radius:12px 12px 0 0;">
          <strong style="font-size:18px;">New NoSo Pledge</strong>
        </div>

        <div style="border:1px solid #e7e0f0;border-top:none;border-radius:0 0 12px 12px;padding:20px;">
          <p style="margin:0 0 16px;">A new pledge has been submitted.</p>

          <p style="margin:0 0 10px;"><strong>Name:</strong> ${escapeHtml(pledge.name)}</p>
          <p style="margin:0 0 10px;"><strong>Email:</strong> ${escapeHtml(pledge.email)}</p>
          <p style="margin:0 0 10px;"><strong>Country:</strong> ${escapeHtml(pledge.country || '-')}</p>
          <p style="margin:0 0 10px;"><strong>Pledge:</strong> ${escapeHtml(pledge.type)}</p>
          <p style="margin:0 0 10px;"><strong>Platforms:</strong> ${escapeHtml(pledge.platforms || '-')}</p>
          <p style="margin:0 0 10px;"><strong>Duration:</strong> ${escapeHtml(pledge.duration || '-')}</p>
          <p style="margin:0 0 10px;"><strong>Reason:</strong> ${escapeHtml(pledge.reason || '-')}</p>
          <p style="margin:0;"><strong>Time:</strong> ${escapeHtml(formatDate(pledge.ts))}</p>
        </div>
      </div>
    `;

    jobs.push(
      resend.emails.send({
        from: FROM_ADDRESS,
        to: ADMIN_EMAIL,
        subject: `New pledge: ${pledge.name} (${pledge.type})`,
        html: adminHtml,
        replyTo: pledge.email,
      })
    );
  } else {
    console.error(
      '[email] Resend or ADMIN_EMAIL is not configured. Admin email skipped.'
    );
  }

  const results = await Promise.allSettled(jobs);

  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      console.error(
        `[email] Email job ${index + 1} failed:`,
        result.reason?.message || result.reason
      );
    } else if (result.value?.error) {
      console.error(
        `[email] Email job ${index + 1} returned an error:`,
        result.value.error
      );
    }
  });
}

export default async function handler(req, res) {
  // GET: Return public pledges without email addresses.
  if (req.method === 'GET') {
    try {
      const stored = (await kv.lrange(LIST_KEY, 0, -1)) || [];

      const publicPledges = stored.map(({ email, ...pledge }) => pledge);

      return res.status(200).json(publicPledges);
    } catch (error) {
      console.error('[pledges] Failed to load pledges:', error?.message || error);

      return res.status(500).json({
        error: 'Failed to load pledges',
      });
    }
  }

  // POST: Validate and save a new pledge.
  if (req.method === 'POST') {
    try {
      const body =
        typeof req.body === 'string'
          ? JSON.parse(req.body)
          : req.body;

      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return res.status(400).json({
          error: 'Invalid request body',
        });
      }

      const type = body.type;

      if (type !== 'Deep Reset' && type !== 'Reclaim Window') {
        return res.status(400).json({
          error: 'Invalid pledge type',
        });
      }

      const email = String(body.email || '')
        .trim()
        .slice(0, MAX_EMAIL_LEN);

      if (!isValidEmail(email)) {
        return res.status(400).json({
          error: 'A valid email is required',
        });
      }

      const name =
        String(body.name || 'Anonymous')
          .trim()
          .slice(0, MAX_NAME_LEN) || 'Anonymous';

      const duration = String(body.duration || '')
        .trim()
        .slice(0, MAX_DURATION_LEN);

      const country = String(body.country || '')
        .trim()
        .slice(0, MAX_COUNTRY_LEN);

      const reason = String(body.reason || '')
        .trim()
        .slice(0, MAX_REASON_LEN);

      const platforms = String(body.platforms || '')
        .trim()
        .slice(0, MAX_PLATFORMS_LEN);

      const pledge = {
        id:
          'p_' +
          Date.now() +
          '_' +
          Math.random().toString(36).slice(2, 8),
        name,
        email,
        country,
        type,
        platforms,
        duration,
        reason,
        ts: Date.now(),
      };

      await kv.lpush(LIST_KEY, pledge);
      await kv.ltrim(LIST_KEY, 0, 999);

      // Email delivery happens after saving and does not block the response.
      sendEmails(pledge).catch((error) => {
        console.error(
          '[email] sendEmails failed:',
          error?.message || error
        );
      });

      const { email: privateEmail, ...publicPledge } = pledge;

      return res.status(200).json({
        ok: true,
        pledge: publicPledge,
      });
    } catch (error) {
      console.error('[pledges] Failed to save pledge:', error?.message || error);

      return res.status(500).json({
        error: 'Failed to save pledge',
      });
    }
  }

  // DELETE: Remove a pledge using the administrator key.
  if (req.method === 'DELETE') {
    try {
      if (!ADMIN_KEY) {
        return res.status(500).json({
          error: 'Admin deletion is not configured',
        });
      }

      const providedKey = req.headers['x-admin-key'];

      if (
        typeof providedKey !== 'string' ||
        providedKey.length === 0 ||
        providedKey !== ADMIN_KEY
      ) {
        return res.status(401).json({
          error: 'Invalid admin passcode',
        });
      }

      const id = req.query?.id;

      if (typeof id !== 'string' || !id.trim()) {
        return res.status(400).json({
          error: 'Missing pledge id',
        });
      }

      const stored = (await kv.lrange(LIST_KEY, 0, -1)) || [];
      const match = stored.find((pledge) => pledge.id === id);

      if (!match) {
        return res.status(404).json({
          error: 'Pledge not found',
        });
      }

      await kv.lrem(LIST_KEY, 1, match);

      return res.status(200).json({
        ok: true,
      });
    } catch (error) {
      console.error('[pledges] Failed to delete pledge:', error?.message || error);

      return res.status(500).json({
        error: 'Failed to delete pledge',
      });
    }
  }

  res.setHeader('Allow', ['GET', 'POST', 'DELETE']);

  return res.status(405).end('Method Not Allowed');
}