/**
 * Vercel Serverless Function: /api/presence
 * Pelacakan status online anggota Royal Priesthood (Heartbeat + Cloudflare R2)
 */

const ONLINE_TTL_MS = 90 * 1000; // 90 detik tanpa heartbeat -> dianggap offline
const KEY = 'rp_online_presence.json';

if (!globalThis.__rpPresenceMemStore) {
  globalThis.__rpPresenceMemStore = [];
}

function pruneOnlineUsers(list, now) {
  if (!Array.isArray(list)) return [];
  const byEmail = new Map();
  for (const item of list) {
    if (!item || !item.email) continue;
    const email = String(item.email).trim().toLowerCase();
    const lastSeen = Number(item.lastSeen) || 0;
    if (!email || now - lastSeen > ONLINE_TTL_MS) continue;
    const prev = byEmail.get(email);
    if (!prev || lastSeen > prev.lastSeen) {
      byEmail.set(email, {
        email,
        name: String(item.name || item.nickname || email.split('@')[0]).slice(0, 80),
        nickname: String(item.nickname || item.name || email.split('@')[0]).slice(0, 40),
        role: String(item.role || 'GENERAL').slice(0, 24),
        photo: typeof item.photo === 'string' && (item.photo.startsWith('http://') || item.photo.startsWith('https://') || item.photo.startsWith('assets/')) ? item.photo : '',
        activeTab: String(item.activeTab || 'schedule').slice(0, 32),
        sessionId: String(item.sessionId || '').slice(0, 48),
        lastSeen
      });
    }
  }
  return Array.from(byEmail.values()).sort((a, b) => b.lastSeen - a.lastSeen);
}

function parseBodySafe(rawBody) {
  if (!rawBody) return {};
  if (typeof rawBody === 'object') return rawBody;
  if (typeof rawBody === 'string') {
    try {
      return JSON.parse(rawBody);
    } catch {
      return {};
    }
  }
  return {};
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const R2_ACCOUNT_ID = (process.env.R2_ACCOUNT_ID || '').trim();
  const R2_ACCESS_KEY_ID = (process.env.R2_ACCESS_KEY_ID || '').trim();
  const R2_SECRET_ACCESS_KEY = (process.env.R2_SECRET_ACCESS_KEY || '').trim();
  const BUCKET = (process.env.R2_BUCKET_NAME || 'rp-mdc-vault').trim() || 'rp-mdc-vault';

  let s3 = null;
  if (R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY) {
    try {
      const { S3Client } = await import('@aws-sdk/client-s3');
      s3 = new S3Client({
        region: 'auto',
        endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: {
          accessKeyId: R2_ACCESS_KEY_ID,
          secretAccessKey: R2_SECRET_ACCESS_KEY
        }
      });
    } catch (err) {
      console.warn('Presence S3 init fallback to memory:', err.message);
    }
  }

  async function readPresenceList(now) {
    if (!s3) {
      const pruned = pruneOnlineUsers(globalThis.__rpPresenceMemStore, now);
      globalThis.__rpPresenceMemStore = pruned;
      return pruned;
    }
    try {
      const { GetObjectCommand } = await import('@aws-sdk/client-s3');
      const data = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: KEY }));
      const str = await data.Body.transformToString();
      const parsed = JSON.parse(str);
      const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.users) ? parsed.users : []);
      return pruneOnlineUsers(list, now);
    } catch {
      return pruneOnlineUsers(globalThis.__rpPresenceMemStore, now);
    }
  }

  async function writePresenceList(list) {
    globalThis.__rpPresenceMemStore = list;
    if (!s3) return false;
    try {
      const { PutObjectCommand } = await import('@aws-sdk/client-s3');
      await s3.send(new PutObjectCommand({
        Bucket: BUCKET,
        Key: KEY,
        Body: JSON.stringify(list),
        ContentType: 'application/json'
      }));
      return true;
    } catch (err) {
      console.warn('Presence R2 write warning:', err.message);
      return false;
    }
  }

  const now = Date.now();

  if (req.method === 'GET') {
    const onlineUsers = await readPresenceList(now);
    return res.status(200).json({
      success: true,
      cloud: !!s3,
      count: onlineUsers.length,
      onlineUsers,
      serverTime: now
    });
  }

  if (req.method === 'POST') {
    const body = parseBodySafe(req.body);
    const action = String(body.action || 'heartbeat').toLowerCase();
    const email = String(body.email || '').trim().toLowerCase();

    let list = await readPresenceList(now);

    if (action === 'offline') {
      if (email) {
        list = list.filter(u => u.email !== email || (body.sessionId && u.sessionId && u.sessionId !== String(body.sessionId)));
      } else if (body.sessionId) {
        list = list.filter(u => u.sessionId !== String(body.sessionId));
      }
      await writePresenceList(list);
      return res.status(200).json({
        success: true,
        cloud: !!s3,
        count: list.length,
        onlineUsers: list,
        serverTime: now
      });
    }

    if (!email) {
      return res.status(200).json({
        success: true,
        cloud: !!s3,
        count: list.length,
        onlineUsers: list,
        serverTime: now
      });
    }

    list = list.filter(u => u.email !== email);
    list.unshift({
      email,
      name: String(body.name || body.nickname || email.split('@')[0]).slice(0, 80),
      nickname: String(body.nickname || body.name || email.split('@')[0]).slice(0, 40),
      role: String(body.role || 'GENERAL').slice(0, 24),
      photo: typeof body.photo === 'string' && (body.photo.startsWith('http://') || body.photo.startsWith('https://') || body.photo.startsWith('assets/')) ? body.photo : '',
      activeTab: String(body.activeTab || 'schedule').slice(0, 32),
      sessionId: String(body.sessionId || '').slice(0, 48),
      lastSeen: now
    });

    const pruned = pruneOnlineUsers(list, now);
    await writePresenceList(pruned);

    return res.status(200).json({
      success: true,
      cloud: !!s3,
      count: pruned.length,
      onlineUsers: pruned,
      serverTime: now
    });
  }

  return res.status(405).json({ message: 'Method Not Allowed' });
}
