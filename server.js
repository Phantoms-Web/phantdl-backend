const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { execFile } = require('child_process');
const { promisify } = require('util');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const execFileAsync = promisify(execFile);
const app = express();
const PORT = process.env.PORT || 3000;

app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));
app.use(cors({ origin: '*' }));
app.use(express.json());

// ───────────────────────────────────────────────
// RATE LIMITING — prevents abuse / runaway costs
// ───────────────────────────────────────────────
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please wait a moment and try again.' }
});
app.use('/api/', apiLimiter);

// ───────────────────────────────────────────────
// SSRF / INPUT SAFETY GUARD
// Blocks requests aimed at internal/private network
// addresses and non-http(s) protocols.
// ───────────────────────────────────────────────
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

// ───────────────────────────────────────────────
// PERSISTENT DOWNLOAD COUNTER
// Stored in a local JSON file. NOTE: on Render's
// free tier, the filesystem is ephemeral — a fresh
// deploy or a cold restart after long inactivity can
// reset this file. See chat notes for an upgrade path
// (e.g. JSONBin/Supabase) if true permanence is needed.
// ───────────────────────────────────────────────
const COUNTER_FILE = path.join(__dirname, 'counter.json');

function loadCounter() {
  try {
    const raw = fs.readFileSync(COUNTER_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return typeof parsed.count === 'number' && parsed.count >= 0 ? parsed.count : 0;
  } catch (e) {
    return 0;
  }
}

function saveCounter(count) {
  try {
    fs.writeFileSync(COUNTER_FILE, JSON.stringify({ count, updatedAt: Date.now() }), 'utf8');
  } catch (e) {
    console.error('Counter save failed:', e.message);
  }
}

let downloadCount = loadCounter();
let writeQueued = false;
function persistCounterSoon() {
  if (writeQueued) return;
  writeQueued = true;
  setTimeout(() => { saveCounter(downloadCount); writeQueued = false; }, 300);
}

app.get('/api/counter', (req, res) => {
  res.json({ count: downloadCount });
});

app.post('/api/counter/increment', (req, res) => {
  downloadCount += 1;
  persistCounterSoon();
  res.json({ count: downloadCount });
});

// ───────────────────────────────────────────────
// HEALTH / WAKE-UP
// ───────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'PhantDL Backend Running!' });
});

app.get('/ping', (req, res) => {
  res.json({ pong: true, count: downloadCount });
});

// ───────────────────────────────────────────────
// yt-dlp WRAPPER
// Uses execFile with an argument array (NOT a shell
// string) so URLs can never break out into shell
// commands — this closes a command-injection hole
// that existed in the previous version.
// ───────────────────────────────────────────────
async function runYtDlp(argsArray) {
  const { stdout } = await execFileAsync('yt-dlp', argsArray, {
    timeout: 120000,
    maxBuffer: 10 * 1024 * 1024
  });
  return stdout;
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
          result.formats.push({
            type: 'video',
            quality: key,
            url: f.url,
            ext: f.ext || 'mp4'
          });
        }
      });

      const audioFormats = info.formats
        .filter(f => f.vcodec === 'none' && f.acodec !== 'none' && f.url)
        .sort((a, b) => (b.abr || 0) - (a.abr || 0));

      if (audioFormats.length > 0) {
        result.formats.push({
          type: 'audio',
          quality: 'Best Audio',
          url: audioFormats[0].url,
          ext: 'mp3'
        });
      }
    }

    if (result.formats.length === 0 && info.url) {
      result.formats.push({
        type: 'video',
        quality: 'Best',
        url: info.url,
        ext: info.ext || 'mp4'
      });
    }

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Could not extract', detail: err.message });
  }
});

// ───────────────────────────────────────────────
// DOWNLOAD PROXY
// Frontend sends every actual file download through
// here. This is what makes Instagram/Twitter/Facebook/
// YouTube downloads work despite the source CDNs
// blocking direct cross-origin browser requests (CORS).
// ───────────────────────────────────────────────
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
