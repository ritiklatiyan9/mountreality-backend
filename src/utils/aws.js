import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import fs from 'fs';

const s3Config = {
  region: process.env.AWS_REGION || 'ap-south-1',
};

// Only explicitly set credentials if they exist in the env,
// otherwise rely on the default provider chain (e.g. EC2 roles, ~/.aws/credentials)
if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
  s3Config.credentials = {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  };
}

const s3Client = new S3Client(s3Config);

export const uploadToS3 = async (filePath, fileName, contentType) => {
  const fileStream = fs.createReadStream(filePath);
  const bucket = process.env.AWS_S3_BUCKET_NAME || process.env.AWS_S3_BUCKET;
  const region = process.env.AWS_REGION || 'ap-south-1';
  const ext = fileName.split('.').pop().toLowerCase();
  let folder = 'uploads';
  if (['jpg','jpeg','png','webp'].includes(ext)) folder = 'vouchers';
  else if (['pdf'].includes(ext)) folder = 'vouchers';
  const uniqueKey = `${folder}/${Date.now()}-${fileName}`;

  // Use multipart upload to avoid MaxMessageLengthExceeded
  const upload = new Upload({
    client: s3Client,
    params: {
      Bucket: bucket,
      Key: uniqueKey,
      Body: fileStream,
      ContentType: contentType,
    },
    queueSize: 4,
    partSize: 5 * 1024 * 1024, // 5MB parts
  });

  await upload.done();
  return `https://${bucket}.s3.${region}.amazonaws.com/${uniqueKey}`;
};