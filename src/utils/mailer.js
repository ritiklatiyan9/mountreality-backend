import nodemailer from 'nodemailer';

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
