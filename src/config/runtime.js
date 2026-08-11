const production = process.env.NODE_ENV === 'production';

const required = (name, minimumLength = 1) => {
  const value = String(process.env[name] || '').trim();
  if (value.length < minimumLength) return `${name} must be set${minimumLength > 1 ? ` and at least ${minimumLength} characters` : ''}`;
  return null;
};

export function validateRuntimeConfig() {
  const errors = [
    required('JWT_ACCESS_SECRET', 32),
    required('JWT_REFRESH_SECRET', 32),
    required('RECEIPT_VERIFY_SECRET', 32),
    required('DB_HOST'),
    required('DB_NAME'),
    required('DB_USER'),
  ].filter(Boolean);

  if (process.env.JWT_ACCESS_SECRET && process.env.JWT_ACCESS_SECRET === process.env.JWT_REFRESH_SECRET) {
    errors.push('JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be different');
  }
  if (production) {
    const origins = String(process.env.CORS_ORIGINS || '').trim();
    if (!origins || origins.split(',').some((origin) => origin.trim() === '*')) {
      errors.push('CORS_ORIGINS must be a non-wildcard production allowlist');
    }
    if (!String(process.env.AWS_S3_BUCKET_NAME || process.env.AWS_S3_BUCKET || '').trim()) {
      errors.push('AWS_S3_BUCKET_NAME is required in production; private files cannot use local disk');
    }
    if (process.env.DB_SSL_REJECT_UNAUTHORIZED === 'false') {
      errors.push('DB_SSL_REJECT_UNAUTHORIZED=false is not allowed in production');
    }
    if (String(process.env.FRONTEND_URL || '').trim() && !String(process.env.FRONTEND_URL).startsWith('https://')) {
      errors.push('FRONTEND_URL must use HTTPS in production');
    }
  }

  if (errors.length) {
    throw new Error(`Invalid runtime configuration:\n- ${errors.join('\n- ')}`);
  }
}

export const isProduction = production;
