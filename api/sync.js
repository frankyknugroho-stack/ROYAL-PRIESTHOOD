/**
 * Vercel Serverless Function: /api/sync
 * Sinkronisasi Master Data Royal Priesthood (Schedules, Setlists, Edifikasi, Team Members)
 * ke Cloudflare R2 Storage
 */

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const R2_ACCOUNT_ID = (process.env.R2_ACCOUNT_ID || '').trim();
  const R2_ACCESS_KEY_ID = (process.env.R2_ACCESS_KEY_ID || '').trim();
  const R2_SECRET_ACCESS_KEY = (process.env.R2_SECRET_ACCESS_KEY || '').trim();
  const R2_BUCKET_NAME = (process.env.R2_BUCKET_NAME || 'rp-mdc-vault').trim();

  const missingKeys = [];
  if (!R2_ACCOUNT_ID) missingKeys.push('R2_ACCOUNT_ID');
  if (!R2_ACCESS_KEY_ID) missingKeys.push('R2_ACCESS_KEY_ID');
  if (!R2_SECRET_ACCESS_KEY) missingKeys.push('R2_SECRET_ACCESS_KEY');

  let s3 = null;
  let initError = null;
  if (missingKeys.length === 0) {
    try {
      const { S3Client } = await import('@aws-sdk/client-s3');
      s3 = new S3Client({
        region: 'auto',
        endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: {
          accessKeyId: R2_ACCESS_KEY_ID,
          secretAccessKey: R2_SECRET_ACCESS_KEY,
        },
      });
    } catch (err) {
      initError = err.message;
      console.warn('AWS SDK S3 Client not initialized:', err.message);
    }
  }

  const BUCKET = R2_BUCKET_NAME || 'rp-mdc-vault';
  const KEY = 'rp_master_data.json';

  if (req.method === 'GET') {
    if (!s3) {
      return res.status(200).json({
        success: true,
        cloud: false,
        missingKeys,
        initError,
        message: missingKeys.length > 0
          ? `Running in Local Storage / Offline mode. Missing: ${missingKeys.join(', ')}`
          : `S3 init error: ${initError}`
      });
    }
    try {
      const { GetObjectCommand } = await import('@aws-sdk/client-s3');
      const data = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: KEY }));
      const str = await data.Body.transformToString();
      return res.status(200).json({ success: true, cloud: true, hasData: true, data: JSON.parse(str) });
    } catch (err) {
      return res.status(200).json({ success: true, cloud: true, hasData: false, message: 'Bucket connected. Initial file pending.', error: err.message });
    }
  }

  if (req.method === 'POST') {
    if (!s3) {
      return res.status(200).json({ success: true, cloud: false, message: 'Saved locally in browser only (R2 credentials not configured)' });
    }
    try {
      const payload = req.body;
      const { PutObjectCommand } = await import('@aws-sdk/client-s3');
      await s3.send(new PutObjectCommand({
        Bucket: BUCKET,
        Key: KEY,
        Body: JSON.stringify(payload, null, 2),
        ContentType: 'application/json',
      }));
      return res.status(200).json({ success: true, cloud: true, message: 'Data synced to Cloudflare R2 successfully' });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  return res.status(405).json({ message: 'Method Not Allowed' });
}
