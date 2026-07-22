import { uploadToS3 } from './aws.js';
import { uploadToCloudinary } from './cloudinary.js';
import { cleanupFile } from '../middlewares/multer.middleware.js';

export const uploadSingle = async (file, provider) => {
  const filePath = file.path;
  let url;
  if (provider === 's3') {
    url = await uploadToS3(filePath, file.filename, file.mimetype);
  } else {
    url = await uploadToCloudinary(filePath);
  }
  cleanupFile(filePath);
  return url;
};

export const uploadMany = async (files, provider) => {
  const urls = [];
  for (const file of files) {
    const url = await uploadSingle(file, provider);
    urls.push(url);
  }
  return urls;
};