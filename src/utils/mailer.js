import nodemailer from 'nodemailer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * Outbound mail (Nodemailer) — used for the admin login OTP. Same SMTP mailbox as
 * the booking app (SMTP_* env; Gmail needs an App Password).
 *
 * When SMTP is not configured the transporter is null and admin login degrades to
 * single-step (with a server-side warning) instead of locking everyone out.
 */
const HOST = process.env.SMTP_HOST;
const PORT = Number(process.env.SMTP_PORT) || 587;
const USER = process.env.SMTP_USER;
const PASS = process.env.SMTP_PASS;

let transporter = null;
if (HOST && USER && PASS) {
  transporter = nodemailer.createTransport({
    host: HOST,
    port: PORT,
    secure: process.env.SMTP_SECURE === 'true' || PORT === 465,
    auth: { user: USER, pass: PASS },
  });
  console.log(`[rgaccount-api] Mailer ready (${HOST}:${PORT})`);
} else {
  console.warn('[rgaccount-api] SMTP not configured — admin login OTP is DISABLED until SMTP_HOST/SMTP_USER/SMTP_PASS are set');
}

export const mailerEnabled = () => !!transporter;

const escapeHtml = (value) => String(value ?? '').replace(/[<>&"]/g, (char) => ({
  '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;',
}[char]));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Banners live in the owner panel's public/ folder (sibling app under Accounts/).
// If a file isn't there yet, we send without the image instead of failing.
const BANNER_DIR = path.resolve(__dirname, '../../../owner/public');

const bannerAttachment = (filename, cid) => {
  const filePath = path.join(BANNER_DIR, filename);
  if (!fs.existsSync(filePath)) {
    console.warn(`[rgaccount-api] Banner not found: ${filePath} — sending without it`);
    return null;
  }
  // Read into a buffer (rather than passing `path`) so the file is attached
  // exactly as it is on disk at send time — no lazy-stream surprises.
  return { filename, content: fs.readFileSync(filePath), cid, contentType: 'image/png' };
};

const FONT_STACK = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const FRONTEND_URL = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');
const OWNER_PANEL_URL = (process.env.OWNER_PANEL_URL || 'http://localhost:5174').replace(/\/$/, '');

// Organizations get a subdomain (org.subdomain, e.g. "latiyan-developer") under the
// platform's apex domain — same convention the Owner Panel's Companies page already
// renders (`${org.subdomain}.mountreality.com`). Emails link there instead of
// localhost whenever we know the org's subdomain.
const orgLoginUrl = (subdomain) => (subdomain ? `https://${subdomain}.mountreality.com/login` : `${FRONTEND_URL}/login`);

/** Shared shell for the customer-facing (banner + CTA) emails — registration
 * and plan purchase. A plain operational card, matching the app's own blue. */
const emailShell = ({ bannerCid, title, bodyHtml, ctaLabel, ctaUrl }) => `
  <div style="background:#f1f5f9;padding:32px 16px;font-family:${FONT_STACK}">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e2e8f0">
      ${bannerCid ? `<img src="cid:${bannerCid}" alt="${escapeHtml(title)}" width="560" style="display:block;width:100%;height:auto" />` : ''}
      <div style="padding:32px 36px">
        <p style="margin:0 0 6px;color:#2563eb;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase">Mount Reality</p>
        <h1 style="margin:0 0 18px;color:#0f172a;font-size:22px;font-weight:700;letter-spacing:-0.01em">${escapeHtml(title)}</h1>
        ${bodyHtml}
        ${ctaUrl ? `
        <div style="margin-top:28px">
          <a href="${escapeHtml(ctaUrl)}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:12px 22px;border-radius:10px">${escapeHtml(ctaLabel || 'Open Mount Reality')}</a>
        </div>` : ''}
      </div>
      <div style="padding:18px 36px;background:#f8fafc;border-top:1px solid #e2e8f0">
        <p style="margin:0;color:#94a3b8;font-size:11px;line-height:1.6">Mount Reality — plot &amp; farmer accounting for developers.<br/>You're receiving this because an account action happened on your behalf.</p>
      </div>
    </div>
  </div>`;

/** Send the 6-digit login code. Throws on delivery failure (caller surfaces 502). */
export async function sendLoginOtpEmail({ to, name, otp, minutes }) {
  const brand = '#1d4ed8';
  await transporter.sendMail({
    from: process.env.SMTP_FROM || `"DG Account ERP" <${USER}>`,
    to,
    subject: `${otp} is your DG Account sign-in code`,
    text: `Hello ${name || ''}\n\nYour DG Account sign-in verification code is: ${otp}\nIt expires in ${minutes} minutes.\n\nIf you did not try to sign in, please change your password immediately.`,
    html: `
      <div style="font-family:Arial,Helvetica,sans-serif;max-width:440px;margin:0 auto;padding:24px;border:1px solid #e2e8f0;border-radius:12px">
        <h2 style="color:${brand};margin:0 0 4px">DG Account</h2>
        <p style="color:#64748b;font-size:12px;margin:0 0 20px">Accounting ERP — sign-in verification</p>
        <p style="color:#0f172a;font-size:14px">Hello ${name || 'Admin'},</p>
        <p style="color:#0f172a;font-size:14px">Use this code to finish signing in:</p>
        <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:10px;text-align:center;padding:16px;margin:16px 0">
          <span style="font-size:32px;letter-spacing:10px;font-weight:bold;color:${brand}">${otp}</span>
        </div>
        <p style="color:#64748b;font-size:12px">The code expires in <b>${minutes} minutes</b> and works only once.</p>
        <p style="color:#94a3b8;font-size:11px;margin-top:20px">Didn't try to sign in? Change your password immediately and inform your administrator.</p>
      </div>`,
  });
}

/** Compliance reminders share the configured SMTP transport but use a separate,
 * plain operational template. Throws on delivery failure so the scheduler can
 * persist a retryable FAILED notification log row. */
export async function sendComplianceReminderEmail({
  to, name, title, message, dueDate, siteName, actionUrl,
}) {
  if (!transporter) throw new Error('SMTP is not configured');
  const safe = (value) => String(value || '').replace(/[<>&"]/g, (char) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;',
  }[char]));
  await transporter.sendMail({
    from: process.env.SMTP_FROM || `"MountReality" <${USER}>`,
    to,
    subject: `[MountReality] ${title}`,
    text: `${message}\n${dueDate ? `Due: ${dueDate}\n` : ''}${siteName ? `Site: ${siteName}\n` : ''}${actionUrl || ''}`,
    html: `
      <div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:auto;padding:24px;border:1px solid #e2e8f0;border-radius:14px">
        <p style="margin:0;color:#2563eb;font-size:12px;font-weight:bold;letter-spacing:.08em;text-transform:uppercase">MountReality Compliance</p>
        <h2 style="margin:8px 0 12px;color:#0f172a">${safe(title)}</h2>
        <p style="color:#334155;line-height:1.6">${safe(message)}</p>
        ${dueDate ? `<p style="color:#475569"><b>Due:</b> ${safe(dueDate)}</p>` : ''}
        ${siteName ? `<p style="color:#475569"><b>Site:</b> ${safe(siteName)}</p>` : ''}
        ${actionUrl ? `<a href="${safe(actionUrl)}" style="display:inline-block;margin-top:14px;background:#2563eb;color:white;text-decoration:none;padding:10px 16px;border-radius:9px">Open in MountReality</a>` : ''}
      </div>`,
  });
}

/** Sent to a new company's contact right after registration (self-serve
 * signup, or the Owner Panel's manual "Register a company" flow). Throws on
 * delivery failure — callers fire this without awaiting and log the error. */
export async function sendRegistrationEmail({ to, name, companyName, orgSubdomain }) {
  if (!transporter) throw new Error('SMTP is not configured');
  const banner = bannerAttachment('reg.png', 'reg-banner');
  await transporter.sendMail({
    from: process.env.SMTP_FROM || `"Mount Reality" <${USER}>`,
    to,
    subject: "Welcome to Mount Reality — you're registered!",
    text: `Hello ${name || ''},\n\n${companyName} has been registered on Mount Reality. You can now sign in and get started.`,
    html: emailShell({
      bannerCid: banner?.cid,
      title: 'Registration successful',
      bodyHtml: `
        <p style="color:#0f172a;font-size:15px;line-height:1.7;margin:0 0 12px">Hello ${escapeHtml(name || 'there')},</p>
        <p style="color:#334155;font-size:15px;line-height:1.7;margin:0">
          <b>${escapeHtml(companyName)}</b> has been registered on Mount Reality. You can sign in now and start setting up your sites.
        </p>`,
      ctaLabel: 'Sign in to your dashboard',
      ctaUrl: orgLoginUrl(orgSubdomain),
    }),
    attachments: banner ? [banner] : [],
  });
}

/** Sent to the paying customer once their subscription activates — either via
 * Razorpay (billing.controller.js verifyPayment) or an owner-provisioned
 * plan (owner.controller.js registerOrganization). Throws on delivery failure. */
export async function sendPlanPurchaseEmail({ to, name, companyName, planName, amount, days, orgSubdomain }) {
  if (!transporter) throw new Error('SMTP is not configured');
  const banner = bannerAttachment('plan.png', 'plan-banner');
  await transporter.sendMail({
    from: process.env.SMTP_FROM || `"Mount Reality" <${USER}>`,
    to,
    subject: `Mount Reality — your ${planName} plan is active`,
    text: `Hello ${name || ''},\n\n${companyName}'s ${planName} plan is now active${amount ? ` (₹${amount})` : ''}.`,
    html: emailShell({
      bannerCid: banner?.cid,
      title: 'Your plan is active',
      bodyHtml: `
        <p style="color:#0f172a;font-size:15px;line-height:1.7;margin:0 0 12px">Hello ${escapeHtml(name || 'there')},</p>
        <p style="color:#334155;font-size:15px;line-height:1.7;margin:0 0 12px">
          <b>${escapeHtml(companyName)}</b> is now on the <b>${escapeHtml(planName)}</b> plan${amount ? ` (₹${escapeHtml(amount)})` : ''}${days ? ` for ${escapeHtml(days)} days` : ''}.
        </p>
        <p style="color:#334155;font-size:15px;line-height:1.7;margin:0">Thanks for subscribing — you're all set.</p>`,
      ctaLabel: 'Go to your dashboard',
      ctaUrl: orgLoginUrl(orgSubdomain),
    }),
    attachments: banner ? [banner] : [],
  });
}

/** Internal ops copy — sent to OWNER_NOTIFY_EMAIL for every registration and
 * every plan purchase. No banner (internal mail, not customer-facing).
 * Throws on delivery failure. */
export async function sendOwnerNotificationEmail({
  kind, companyName, contactName, contactEmail, contactPhone, planName, amount, orgId,
}) {
  if (!transporter) throw new Error('SMTP is not configured');
  const label = kind === 'purchase' ? 'plan purchase' : 'registration';
  const manageUrl = orgId ? `${OWNER_PANEL_URL}/companies/${orgId}` : `${OWNER_PANEL_URL}/companies`;
  await transporter.sendMail({
    from: process.env.SMTP_FROM || `"Mount Reality" <${USER}>`,
    to: process.env.OWNER_NOTIFY_EMAIL,
    subject: `[MountReality] New ${label}: ${companyName}`,
    text: `New ${label}\nCompany: ${companyName}\nContact: ${contactName} <${contactEmail}>${contactPhone ? ` (${contactPhone})` : ''}${planName ? `\nPlan: ${planName}${amount ? ` (₹${amount})` : ''}` : ''}\nManage: ${manageUrl}`,
    html: `
      <div style="background:#f1f5f9;padding:32px 16px;font-family:${FONT_STACK}">
        <div style="max-width:480px;margin:0 auto;background:#ffffff;padding:28px 32px;border:1px solid #e2e8f0;border-radius:14px">
          <p style="margin:0 0 6px;color:#2563eb;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase">Mount Reality — New ${escapeHtml(label)}</p>
          <h2 style="margin:8px 0 18px;color:#0f172a;font-size:19px;font-weight:700">${escapeHtml(companyName)}</h2>
          <p style="color:#334155;font-size:14px;line-height:1.8;margin:4px 0"><b>Contact:</b> ${escapeHtml(contactName)} &lt;${escapeHtml(contactEmail)}&gt;</p>
          ${contactPhone ? `<p style="color:#334155;font-size:14px;line-height:1.8;margin:4px 0"><b>Phone:</b> ${escapeHtml(contactPhone)}</p>` : ''}
          ${planName ? `<p style="color:#334155;font-size:14px;line-height:1.8;margin:4px 0"><b>Plan:</b> ${escapeHtml(planName)}${amount ? ` (₹${escapeHtml(amount)})` : ''}</p>` : ''}
          <div style="margin-top:22px">
            <a href="${escapeHtml(manageUrl)}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:11px 20px;border-radius:9px">Manage in Owner Panel</a>
          </div>
        </div>
      </div>`,
  });
}
