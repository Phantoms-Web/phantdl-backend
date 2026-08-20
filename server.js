const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { execFile } = require('child_process');
const { promisify } = require('util');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const execFileAsync = promisify(execFile);
const app = express();
const PORT = process.env.PORT || 3000;

app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));
app.use(cors({ origin: '*' }));
app.use(express.json());

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
let supabase = null;
if (SUPABASE_URL && SUPABASE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
} else {
  console.warn('SUPABASE_URL / SUPABASE_KEY not set — stats endpoints will be disabled.');
}

const KNOWN_PLATFORMS = ['tiktok', 'youtube', 'instagram', 'facebook', 'twitter', 'soundcloud', 'terabox'];

const IP_SALT = process.env.IP_SALT || 'change-this-salt-in-render-env-vars';
function hashIp(ip) {
  return crypto.createHash('sha256').update(IP_SALT + '|' + ip).digest('hex');
}
function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please wait a moment and try again.' }
});
app.use('/api/', apiLimiter);

function isSafeUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (!['http:', 'https:'].includes(u.protocol)) return false;
    const hostname = u.hostname.toLowerCase();
    const blockedExact = ['localhost', '127.0.0.1', '0.0.0.0', '::1'];
    if (blockedExact.includes(hostname)) return false;
    const privateRanges = [
      /^10\./,
      /^172\.(1[6-9]|2\d|3[0-1])\./,
      /^192\.168\./,
      /^169\.254\./
    ];
    if (privateRanges.some(r => r.test(hostname))) return false;
    return true;
  } catch (e) {
    return false;
  }
}

function sanitizeFilename(name) {
  const cleaned = String(name || 'download').replace(/[\r\n"<>]/g, '').slice(0, 150);
  return cleaned || 'download';
}

function detectPlatform(rawUrl) {
  const url = String(rawUrl || '').toLowerCase();
  if (url.includes('tiktok.com')) return 'tiktok';
  if (url.includes('instagram.com')) return 'instagram';
  if (url.includes('youtube.com') || url.includes('youtu.be')) return 'youtube';
  if (url.includes('facebook.com') || url.includes('fb.watch')) return 'facebook';
  if (url.includes('twitter.com') || url.includes('x.com')) return 'twitter';
  if (url.includes('soundcloud.com')) return 'soundcloud';
  if (url.includes('terabox.com') || url.includes('1024terabox.com')) return 'terabox';
  return null;
}

app.get('/', (req, res) => {
  res.json({ status: 'PhantDL Backend Running!' });
});

app.get('/ping', (req, res) => {
  res.json({ pong: true });
});

app.post('/api/visit', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Stats temporarily unavailable' });
  try {
    const visitorHash = hashIp(getClientIp(req));
    const { error } = await supabase.from('visits').insert({ visitor_hash: visitorHash });
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('visit tracking failed:', err.message);
    res.status(500).json({ error: 'Could not record visit' });
  }
});

app.get('/api/stats', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Stats temporarily unavailable' });
  try {
    const { count: totalVisits, error: visitsErr } = await supabase
      .from('visits').select('*', { count: 'exact', head: true });
    if (visitsErr) throw visitsErr;

    const { data: uniqueRows, error: uniqueErr } = await supabase
      .from('visits').select('visitor_hash');
    if (uniqueErr) throw uniqueErr;
    const uniqueVisitors = new Set((uniqueRows || []).map(r => r.visitor_hash)).size;

    const { count: totalDownloads, error: dlErr } = await supabase
      .from('downloads').select('*', { count: 'exact', head: true });
    if (dlErr) throw dlErr;

    res.json({
      uniqueVisitors,
      totalVisits: totalVisits || 0,
      totalDownloads: totalDownloads || 0
    });
  } catch (err) {
    console.error('stats fetch failed:', err.message);
    res.status(500).json({ error: 'Could not load stats' });
  }
});

app.get('/api/leaderboard', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Stats temporarily unavailable' });
  try {
    const { data, error } = await supabase
      .from('platform_stats')
      .select('platform, total_downloads')
      .order('total_downloads', { ascending: false })
      .limit(5);
    if (error) throw error;
    res.json({ leaderboard: data });
  } catch (err) {
    console.error('leaderboard fetch failed:', err.message);
    res.status(500).json({ error: 'Could not load leaderboard' });
  }
});

app.get('/api/counter', async (req, res) => {
  if (!supabase) return res.json({ count: 0 });
  try {
    const { count, error } = await supabase
      .from('downloads').select('*', { count: 'exact', head: true });
    if (error) throw error;
    res.json({ count: count || 0 });
  } catch (err) {
    res.status(500).json({ error: 'Could not load counter' });
  }
});

app.post('/api/counter/increment', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Stats temporarily unavailable' });
  const { platform, contentType } = req.body || {};
  const safePlatform = KNOWN_PLATFORMS.includes(platform) ? platform : null;

  try {
    if (safePlatform) {
      const { error: insertErr } = await supabase
        .from('downloads')
        .insert({ platform: safePlatform, content_type: contentType || null });
      if (insertErr) throw insertErr;

      const { error: rpcErr } = await supabase.rpc('increment_platform_downloads', { p_platform: safePlatform });
      if (rpcErr) throw rpcErr;
    } else {
      await supabase.from('downloads').insert({ platform: 'other', content_type: contentType || null });
    }

    const { count } = await supabase.from('downloads').select('*', { count: 'exact', head: true });
    res.json({ count: count || 0 });
  } catch (err) {
    console.error('counter increment failed:', err.message);
    res.status(500).json({ error: 'Could not update counter' });
  }
});

async function runYtDlp(argsArray) {
  const { stdout } = await execFileAsync('yt-dlp', argsArray, {
    timeout: 120000,
    maxBuffer: 10 * 1024 * 1024
  });
  return stdout;
}

function fetchJson(targetUrl, options = {}) {
  return new Promise((resolve, reject) => {
    const protocol = targetUrl.startsWith('https') ? https : http;
    const req = protocol.get(targetUrl, { timeout: 15000, ...options }, (response) => {
      let data = '';
      response.on('data', chunk => { data += chunk; });
      response.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Invalid JSON from fallback API')); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Fallback API timeout')); });
    req.on('error', reject);
  });
}

async function tiktokFallback(url) {
  const api = `https://www.tikwm.com/api/?url=${encodeURIComponent(url)}&hd=1`;
  const json = await fetchJson(api);
  if (json.code !== 0 || !json.data) throw new Error('TikTok fallback returned no data');
  const d = json.data;
  const formats = [];
  if (d.play) formats.push({ type: 'video', quality: 'SD', url: d.play, ext: 'mp4' });
  if (d.hdplay && d.hdplay !== d.play) formats.push({ type: 'video', quality: 'HD', url: d.hdplay, ext: 'mp4' });
  if (d.music) formats.push({ type: 'audio', quality: 'Best Audio', url: d.music, ext: 'mp3' });
  return { title: d.title || 'TikTok Video', thumbnail: d.cover || '', duration: d.duration || 0, formats };
}

app.get('/api/info', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'URL required' });
  if (!isSafeUrl(url)) return res.status(400).json({ error: 'Invalid URL' });

  try {
    const raw = await runYtDlp(['--dump-json', '--no-playlist', url]);
    const info = JSON.parse(raw);
    const result = {
      title: info.title || 'Media File',
      thumbnail: info.thumbnail || '',
      duration: info.duration || 0,
      formats: []
    };

    if (info.formats) {
      const videoFormats = info.formats
        .filter(f => f.vcodec !== 'none' && f.acodec !== 'none' && f.url)
        .sort((a, b) => (b.height || 0) - (a.height || 0));

      const seen = new Set();
      videoFormats.forEach(f => {
        const key = `${f.height || 'unknown'}p`;
        if (!seen.has(key) && result.formats.filter(x => x.type === 'video').length < 4) {
          seen.add(key);
          result.formats.push({ type: 'video', quality: key, url: f.url, ext: f.ext || 'mp4' });
        }
      });

      const audioFormats = info.formats
        .filter(f => f.vcodec === 'none' && f.acodec !== 'none' && f.url)
        .sort((a, b) => (b.abr || 0) - (a.abr || 0));

      if (audioFormats.length > 0) {
        result.formats.push({ type: 'audio', quality: 'Best Audio', url: audioFormats[0].url, ext: 'mp3' });
      }
    }

    if (result.formats.length === 0 && info.url) {
      result.formats.push({ type: 'video', quality: 'Best', url: info.url, ext: info.ext || 'mp4' });
    }

    res.json(result);
  } catch (primaryErr) {
    const platform = detectPlatform(url);
    try {
      if (platform === 'tiktok') {
        const fallbackResult = await tiktokFallback(url);
        return res.json(fallbackResult);
      }
      throw primaryErr;
    } catch (fallbackErr) {
      res.status(500).json({ error: 'Could not extract', detail: fallbackErr.message });
    }
  }
});

app.get('/api/proxy', (req, res) => {
  const url = req.query.url;
  const filename = sanitizeFilename(req.query.filename);

  if (!url) return res.status(400).json({ error: 'URL required' });
  if (!isSafeUrl(url)) return res.status(400).json({ error: 'Invalid or unsafe URL' });

  const fetchAndPipe = (targetUrl, redirectsLeft) => {
    if (!isSafeUrl(targetUrl)) {
      if (!res.headersSent) res.status(400).json({ error: 'Invalid redirect target' });
      return;
    }
    if (redirectsLeft < 0) {
      if (!res.headersSent) res.status(502).json({ error: 'Too many redirects' });
      return;
    }

    const protocol = targetUrl.startsWith('https') ? https : http;
    const proxyReq = protocol.get(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://www.google.com/'
      },
      timeout: 30000
    }, (response) => {
      if ((response.statusCode === 301 || response.statusCode === 302) && response.headers.location) {
        response.resume();
        fetchAndPipe(response.headers.location, redirectsLeft - 1);
        return;
      }
      if (response.statusCode && response.statusCode >= 400) {
        if (!res.headersSent) res.status(response.statusCode).json({ error: 'Upstream error' });
        return;
      }
      res.setHeader('Content-Type', response.headers['content-type'] || 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      if (response.headers['content-length']) res.setHeader('Content-Length', response.headers['content-length']);
      response.pipe(res);
    });

    proxyReq.on('timeout', () => {
      proxyReq.destroy();
      if (!res.headersSent) res.status(504).json({ error: 'Upstream timeout' });
    });
    proxyReq.on('error', (e) => {
      if (!res.headersSent) res.status(500).json({ error: e.message });
    });
  };

  fetchAndPipe(url, 3);
});

app.listen(PORT, () => console.log(`PhantDL Backend running on port ${PORT}`));
