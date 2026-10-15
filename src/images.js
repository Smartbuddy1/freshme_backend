import { randomUUID } from 'node:crypto';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import sharp from 'sharp';
import { HttpError } from './utils.js';

const filenamePattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.webp$/;
export const imageCacheControl = 'public, max-age=31536000, immutable';
export function isProductImageUrl(value) {
  return value.startsWith('/api/images/') && filenamePattern.test(value.slice('/api/images/'.length));
}
function storageError(code) {
  const error = new HttpError(503, 'Image storage is unavailable. Please try again.');
  error.code = code;
  return error;
}

export function createImageStorage(config, client = new S3Client({
  region: config.AWS_REGION,
  maxAttempts: 2,
  ...(config.AWS_ACCESS_KEY_ID && { credentials: {
    accessKeyId: config.AWS_ACCESS_KEY_ID,
    secretAccessKey: config.AWS_SECRET_ACCESS_KEY,
    ...(config.AWS_SESSION_TOKEN && { sessionToken: config.AWS_SESSION_TOKEN })
  } })
})) {
  const prefix = config.S3_KEY_PREFIX || 'fresh-me/products';
  return {
    async upload(buffer) {
      let body;
      try {
        // Decode actual bytes, cap pixel count, strip metadata and re-encode.
        // The browser's file extension and MIME type are not trusted.
        const image = sharp(buffer, { limitInputPixels: 20000000, failOn: 'error' });
        const metadata = await image.metadata();
        if (!['jpeg', 'png', 'webp'].includes(metadata.format) || (metadata.pages || 1) > 1) throw new Error('Unsupported image');
        body = await image.rotate().resize(640, 640, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
      } catch {
        throw new HttpError(400, 'Choose a valid, non-animated JPG, PNG or WebP image under 20 megapixels.');
      }
      const filename = `${randomUUID()}.webp`;
      try {
        // No ACL or bucket-policy operations: works with private, ACL-disabled buckets.
        await client.send(new PutObjectCommand({
          Bucket: config.S3_BUCKET, Key: `${prefix}/${filename}`, Body: body,
          ContentType: 'image/webp', CacheControl: imageCacheControl
        }), { abortSignal: AbortSignal.timeout(15000) });
      } catch {
        throw storageError('S3_UPLOAD_FAILED');
      }
      return `/api/images/${filename}`;
    },
    async read(filename) {
      if (!filenamePattern.test(filename)) throw new HttpError(404, 'Image not found');
      try {
        const result = await client.send(new GetObjectCommand({
          Bucket: config.S3_BUCKET, Key: `${prefix}/${filename}`
        }), { abortSignal: AbortSignal.timeout(15000) });
        if (!result.Body || result.ContentLength > 5 * 1024 * 1024) throw new Error('Invalid stored image');
        return Buffer.from(await result.Body.transformToByteArray());
      } catch (error) {
        if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) throw new HttpError(404, 'Image not found');
        throw storageError('S3_READ_FAILED');
      }
    }
  };
}
