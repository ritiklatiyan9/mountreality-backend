import { SQSClient, SendMessageBatchCommand } from '@aws-sdk/client-sqs';

/**
 * SQS producer for outbound SMS. The queue is drained by src/workers/smsWorker.js
 * (run it as a separate process: `npm run worker:sms`), which does the actual
 * provider call — nothing is delivered by enqueueing alone.
 */

const sqsConfig = { region: process.env.AWS_SQS_REGION || process.env.AWS_REGION || 'ap-south-1' };
// Same pattern as utils/aws.js — fall back to the default provider chain.
if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
  sqsConfig.credentials = {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  };
}

let client = null;
const getClient = () => (client ||= new SQSClient(sqsConfig));

export const SMS_QUEUE_URL = () => process.env.AWS_SMS_QUEUE_URL || '';
export const isSmsQueueConfigured = () => Boolean(SMS_QUEUE_URL());

/**
 * Enqueue SMS jobs ({ to, message, ... }) in batches of 10 (the SQS batch cap).
 * Returns { queued, failed: [{ index, error }] }; never throws.
 */
export const enqueueSms = async (jobs) => {
  if (!jobs.length) return { queued: 0, failed: [] };
  if (!isSmsQueueConfigured()) return { queued: 0, failed: jobs.map((_, i) => ({ index: i, error: 'AWS_SMS_QUEUE_URL not configured' })) };

  const failed = [];
  let queued = 0;
  for (let start = 0; start < jobs.length; start += 10) {
    const chunk = jobs.slice(start, start + 10);
    try {
      const out = await getClient().send(new SendMessageBatchCommand({
        QueueUrl: SMS_QUEUE_URL(),
        Entries: chunk.map((job, i) => ({ Id: String(i), MessageBody: JSON.stringify(job) })),
      }));
      queued += (out.Successful || []).length;
      for (const f of out.Failed || []) failed.push({ index: start + Number(f.Id), error: f.Message || f.Code });
    } catch (err) {
      for (let i = 0; i < chunk.length; i++) failed.push({ index: start + i, error: err?.message || String(err) });
    }
  }
  return { queued, failed };
};
