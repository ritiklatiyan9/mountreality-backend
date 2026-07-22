import 'dotenv/config';
import { SQSClient, ReceiveMessageCommand, DeleteMessageCommand } from '@aws-sdk/client-sqs';
import pool from '../config/db.js';
import { SMS_QUEUE_URL, isSmsQueueConfigured } from '../utils/sqs.js';

/**
 * SMS queue consumer — run as its own process: `npm run worker:sms`.
 * Long-polls SQS and delivers each job through MSG91 (already the notification
 * provider for WhatsApp receipts). A message is only deleted once it is either
 * delivered or permanently rejected; transient failures are left on the queue
 * for SQS to redeliver.
 */

const sqsConfig = { region: process.env.AWS_SQS_REGION || process.env.AWS_REGION || 'ap-south-1' };
if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
  sqsConfig.credentials = {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  };
}
const sqs = new SQSClient(sqsConfig);

const MSG91_SMS_URL = 'https://control.msg91.com/api/v5/flow/';

/** Send one SMS. Returns { ok, permanent, error } — `permanent` means don't retry. */
const sendSms = async (to, message) => {
  const authKey = process.env.MSG91_AUTH_KEY;
  const flowId = process.env.MSG91_SMS_FLOW_ID;      // DLT-approved flow/template
  const varName = process.env.MSG91_SMS_VAR || 'body'; // variable name in that flow
  if (!authKey || !flowId) return { ok: false, permanent: true, error: 'MSG91_AUTH_KEY / MSG91_SMS_FLOW_ID not configured' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(MSG91_SMS_URL, {
      method: 'POST',
      headers: { authkey: authKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        template_id: flowId,
        sender: process.env.MSG91_SMS_SENDER || undefined,
        short_url: '0',
        recipients: [{ mobiles: to, [varName]: message }],
      }),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, permanent: res.status >= 400 && res.status < 500, error: data?.message || `HTTP ${res.status}` };
    return { ok: true, data };
  } catch (err) {
    return { ok: false, permanent: false, error: err?.message || String(err) };
  } finally {
    clearTimeout(timer);
  }
};

const markLog = async (logId, status, error) => {
  if (!logId) return;
  await pool.query('UPDATE sms_reminder_log SET status = $1, error = $2 WHERE id = $3',
    [status, error ? String(error).slice(0, 500) : null, logId]);
};

const handle = async (msg) => {
  let job;
  try {
    job = JSON.parse(msg.Body);
  } catch {
    console.error('[sms-worker] unparseable message, dropping:', msg.MessageId);
    return true; // delete — retrying garbage never helps
  }
  const { ok, permanent, error } = await sendSms(job.to, job.message);
  if (ok) {
    await markLog(job.log_id, 'sent', null);
    console.log(`[sms-worker] sent to ${job.to} (log ${job.log_id})`);
    return true;
  }
  if (permanent) {
    await markLog(job.log_id, 'failed', error);
    console.error(`[sms-worker] permanent failure for ${job.to}: ${error}`);
    return true;
  }
  console.warn(`[sms-worker] transient failure for ${job.to}: ${error} — leaving on queue`);
  return false;
};

const poll = async () => {
  const out = await sqs.send(new ReceiveMessageCommand({
    QueueUrl: SMS_QUEUE_URL(),
    MaxNumberOfMessages: 10,
    WaitTimeSeconds: 20,
    VisibilityTimeout: 60,
  }));
  for (const msg of out.Messages || []) {
    const done = await handle(msg);
    if (done) await sqs.send(new DeleteMessageCommand({ QueueUrl: SMS_QUEUE_URL(), ReceiptHandle: msg.ReceiptHandle }));
  }
};

const main = async () => {
  if (!isSmsQueueConfigured()) {
    console.error('[sms-worker] AWS_SMS_QUEUE_URL not set — nothing to consume');
    process.exit(1);
  }
  console.log('[sms-worker] polling', SMS_QUEUE_URL());
  let stopping = false;
  process.on('SIGINT', () => { stopping = true; });
  process.on('SIGTERM', () => { stopping = true; });
  while (!stopping) {
    try {
      await poll();
    } catch (err) {
      console.error('[sms-worker] poll failed:', err?.message || err);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  await pool.end();
  process.exit(0);
};

main();
