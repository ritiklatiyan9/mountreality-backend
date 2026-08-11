import { uploadToS3 } from './aws.js';
import { uploadToCloudinary } from './cloudinary.js';
import { cleanupFile } from '../middlewares/multer.middleware.js';

export const uploadSingle = async (file, provider, options = {}) => {
  const filePath = file.path;
  const { localBaseUrl } = options;
  const cloudinaryConfigured = Boolean(
    process.env.CLOUDINARY_CLOUD_NAME
    && process.env.CLOUDINARY_API_KEY
    && process.env.CLOUDINARY_API_SECRET
  );

  // Local development should not pretend a photo was saved when Cloudinary is
  // absent. Keep multer's file and return the API-served URL instead.
  if (provider === 'cloudinary' && !cloudinaryConfigured) {
    if (process.env.NODE_ENV === 'production') throw new Error('Profile image storage is not configured');
    const baseUrl = (localBaseUrl || `http://localhost:${process.env.PORT || 8000}`).replace(/\/$/, '');
    return `${baseUrl}/uploads/members/${encodeURIComponent(file.filename)}`;
  }

  try {
    if (provider === 's3') {
      return await uploadToS3(filePath, file.filename, file.mimetype, options.folder, Boolean(options.returnKey));
    }
    return await uploadToCloudinary(filePath);
  } finally {
    // multer writes member images to disk before the remote upload. Always
    // remove that temporary file, including when the provider is unavailable.
    cleanupFile(filePath);
  }
};

export const uploadMany = async (files, provider) => {
  // Every upload owns and clears its temporary file, including when a sibling
  // fails, so a partial batch cannot leave unbounded files on local disk.
  return Promise.all(files.map((file) => uploadSingle(file, provider)));
};
