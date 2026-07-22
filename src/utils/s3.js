import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Upload } from "@aws-sdk/lib-storage";

import fs from 'fs';
import path from 'path';

const validateAwsConfig = () => {
    // We only throw if we absolutely must strictly enforce AWS.
    // For local fallback, we'll just log warnings.
};

let s3Client = null;
try {
    if (process.env.AWS_ACCESS_KEY_ID) {
        s3Client = new S3Client({
            region: process.env.AWS_REGION || 'us-east-1',
            credentials: {
                accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
                secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
            }
        });
    }
} catch (e) {
    console.warn("⚠️ S3 Client initialization skipped: missing credentials. Falling back to local disk storage.");
}

const BUCKET_NAME = process.env.AWS_S3_BUCKET_NAME || '';
const LOCAL_UPLOAD_DIR = path.join(process.cwd(), 'uploads', 'excel');

// Ensure local directory exists for fallback
if (!fs.existsSync(LOCAL_UPLOAD_DIR)) {
    fs.mkdirSync(LOCAL_UPLOAD_DIR, { recursive: true });
}

export const uploadToS3 = async (fileBuffer, fileName, mimetype) => {
    const uniqueFileName = `${Date.now()}-${Math.round(Math.random() * 1E9)}-${fileName}`;
    
    // Determine folder based on file type
    const ext = fileName.split('.').pop().toLowerCase();
    let folder = 'excel_files';
    if (['pdf'].includes(ext)) folder = 'pdf_files';
    else if (['doc', 'docx'].includes(ext)) folder = 'doc_files';
    
    const s3_key = `${folder}/${uniqueFileName}`;

    if (s3Client && process.env.AWS_ACCESS_KEY_ID) {
        // ACTUAL S3 UPLOAD (multipart to avoid MaxMessageLengthExceeded)
        const upload = new Upload({
            client: s3Client,
            params: {
                Bucket: BUCKET_NAME,
                Key: s3_key,
                Body: fileBuffer,
                ContentType: mimetype,
            },
            queueSize: 4,
            partSize: 5 * 1024 * 1024,
        });
        await upload.done();
        return s3_key;
    } else {
        // LOCAL FALLBACK UPLOAD
        const localPath = path.join(LOCAL_UPLOAD_DIR, uniqueFileName);
        fs.writeFileSync(localPath, fileBuffer);
        return `local::${uniqueFileName}`; // special prefix so we know it's a local file
    }
};

export const deleteFromS3 = async (s3_key) => {
    if (!s3_key) return;

    if (s3_key.startsWith('local::')) {
        // LOCAL DELETE
        const fileName = s3_key.replace('local::', '');
        const localPath = path.join(LOCAL_UPLOAD_DIR, fileName);
        if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
    } else if (s3Client && process.env.AWS_ACCESS_KEY_ID) {
        // ACTUAL S3 DELETE
        const command = new DeleteObjectCommand({
            Bucket: BUCKET_NAME,
            Key: s3_key,
        });
        await s3Client.send(command);
    }
};

export const generateSignedGetUrl = async (s3_key) => {
    if (!s3_key) return null;

    if (s3_key.startsWith('local::')) {
        // LOCAL GET URL
        const fileName = s3_key.replace('local::', '');
        return `http://localhost:${process.env.PORT || 5000}/uploads/excel/${fileName}`;
    } else if (s3Client && process.env.AWS_ACCESS_KEY_ID) {
        // ACTUAL S3 GET URL
        const command = new GetObjectCommand({
            Bucket: BUCKET_NAME,
            Key: s3_key,
        });
        // URL expires in 1 hour (3600 seconds)
        return await getSignedUrl(s3Client, command, { expiresIn: 3600 });
    }

    // If we're here, it means we have an S3 key but no S3 client
    return null;
};
