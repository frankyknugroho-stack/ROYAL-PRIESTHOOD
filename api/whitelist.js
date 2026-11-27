/**
 * Vercel Serverless Function: /api/whitelist
 * Terhubung ke Cloudflare R2 Bucket / KV Store untuk Whitelist Gatekeeper
 */

// Super Admin yang berhak memodifikasi whitelist
const SUPER_ADMIN_EMAIL = 'franky.k.nugroho@gmail.com';

// Default master fallback whitelist jika Cloudflare R2 belum disetup
const DEFAULT_WHITELIST = [
  { email: 'franky.k.nugroho@gmail.com', name: 'Franky K. Nugroho', role: 'RPM', addedAt: '2026-11-01' },
  { email: 'agie@mdcsurabaya.org', name: 'Agie', role: 'WL_MD', addedAt: '2026-11-01' },
  { email: 'ronald@mdcsurabaya.org', name: 'Ronald', role: 'WL_MD', addedAt: '2026-11-01' },
  { email: 'cindy@mdcsurabaya.org', name: 'Cindy', role: 'GENERAL', addedAt: '2026-11-01' }
];

export default async function handler(req, res) {
  // CORS & Anti-Cache Headers
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization'
  );
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  // Cek apakah kredensial Cloudflare R2 tersedia di environment variables
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME } = process.env;

  let s3 = null;
  if (R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY) {
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
      console.warn('AWS SDK S3 Client not initialized:', err.message);
    }
  }

  const BUCKET = R2_BUCKET_NAME || 'rp-mdc-vault';
  const KEY = 'cdm_vault_whitelist.json';

  // Helper untuk membaca dari Cloudflare R2
  async function getWhitelistData() {
    if (!s3) return DEFAULT_WHITELIST;
    try {
      const { GetObjectCommand } = await import('@aws-sdk/client-s3');
      const data = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: KEY }));
      const str = await data.Body.transformToString();
      return JSON.parse(str);
    } catch (err) {
      console.warn('R2 read fallback to default:', err.message);
      return DEFAULT_WHITELIST;
    }
  }

  // Helper untuk menulis ke Cloudflare R2
  async function saveWhitelistData(list) {
    if (!s3) return false;
    try {
      const { PutObjectCommand } = await import('@aws-sdk/client-s3');
      await s3.send(new PutObjectCommand({
        Bucket: BUCKET,
        Key: KEY,
        Body: JSON.stringify(list, null, 2),
        ContentType: 'application/json',
      }));
      return true;
    } catch (err) {
      console.error('R2 write error:', err.message);
      return false;
    }
  }

  if (req.method === 'GET') {
    const data = await getWhitelistData();
    return res.status(200).json({ success: true, count: data.length, whitelist: data });
  }

  if (req.method === 'POST') {
    const { action, email, name, role, requesterEmail } = req.body || {};

    // Validasi otorisasi Super Admin atau RPM
    let list = await getWhitelistData();
    const isSuper = requesterEmail && requesterEmail.toLowerCase() === SUPER_ADMIN_EMAIL.toLowerCase();
    const isRpm = requesterEmail && list.some(x => x.email && x.email.toLowerCase() === requesterEmail.toLowerCase() && (x.role === 'RPM' || x.role === 'SUPER_ADMIN'));
    if (!isSuper && !isRpm) {
      return res.status(403).json({ success: false, message: 'Hanya Super Admin (' + SUPER_ADMIN_EMAIL + ') atau RPM yang berhak mengelola whitelist.' });
    }

    if (action === 'add') {
      if (!email) return res.status(400).json({ success: false, message: 'Email wajib diisi.' });
      const { nickname, positions, branches } = req.body || {};
      const lower = email.trim().toLowerCase();
      const existing = list.find(x => x.email.toLowerCase() === lower);
      if (existing) {
        if (name) existing.name = name.trim();
        if (nickname) existing.nickname = nickname.trim();
        if (role) existing.role = role;
        if (positions) existing.positions = Array.isArray(positions) ? positions : [positions];
        if (branches) existing.branches = Array.isArray(branches) ? branches : [branches];
      } else {
        list.push({
          email: lower,
          name: name ? name.trim() : lower.split('@')[0],
          nickname: nickname ? nickname.trim() : (name ? name.trim().split(' ')[0] : lower.split('@')[0]),
          role: role || 'GENERAL',
          positions: Array.isArray(positions) ? positions : (positions ? [positions] : ['Singers']),
          branches: Array.isArray(branches) ? branches : (branches ? [branches] : ['putat', 'cw']),
          addedAt: new Date().toISOString()
        });
      }
      await saveWhitelistData(list);
      return res.status(200).json({ success: true, message: `Email ${lower} berhasil ditambahkan ke Cloud Whitelist.`, whitelist: list });
    }

    if (action === 'remove') {
      if (!email) return res.status(400).json({ success: false, message: 'Email wajib diisi.' });
      const lower = email.trim().toLowerCase();
      if (lower === SUPER_ADMIN_EMAIL.toLowerCase()) {
        return res.status(400).json({ success: false, message: 'Super Admin tidak dapat dihapus.' });
      }
      list = list.filter(x => x.email.toLowerCase() !== lower);
      await saveWhitelistData(list);
      return res.status(200).json({ success: true, message: `Email ${lower} berhasil dihapus.`, whitelist: list });
    }

    return res.status(400).json({ success: false, message: 'Action tidak valid.' });
  }

  return res.status(405).json({ message: 'Method Not Allowed' });
}
