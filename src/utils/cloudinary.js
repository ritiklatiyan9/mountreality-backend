import { v2 as cloudinary } from 'cloudinary';

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

/**
 * Upload a file and retain the Cloudinary identity needed for compensation.
 * Most callers only persist the URL, but multi-step workflows must be able to
 * destroy a just-uploaded object when their database transaction fails.
 */
export const uploadCloudinaryAsset = async (filePath, folder = 'uploads') => {
  const result = await cloudinary.uploader.upload(filePath, {
    folder,
    // Compress & resize images to reduce size
    transformation: [
      { width: 1200, crop: 'limit' },     // max width 1200px
      { quality: 'auto:good' },            // auto quality optimization
      { fetch_format: 'auto' },            // auto format (webp/avif where supported)
    ],
    resource_type: 'auto',
  });
  return {
    url: result.secure_url,
    publicId: result.public_id,
    resourceType: result.resource_type || 'image',
  };
};

/** Backward-compatible URL-only upload helper used by existing modules. */
export const uploadToCloudinary = async (filePath, folder = 'uploads') => {
  const asset = await uploadCloudinaryAsset(filePath, folder);
  return asset.url;
};

/** Remove an upload that must be rolled back after a later workflow failure. */
export const deleteCloudinaryAsset = async (asset) => {
  if (!asset?.publicId) return null;
  return cloudinary.uploader.destroy(asset.publicId, {
    resource_type: asset.resourceType || 'image',
    invalidate: true,
  });
};
