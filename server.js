const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const { promisify } = require('util');
const https = require('https');
const http = require('http');

const execAsync = promisify(exec);
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'PhantDL Backend Running!' });
});

app.get('/ping', (req, res) => {
  res.json({ pong: true });
});

async function runYtDlp(args) {
  const { stdout } = await execAsync(`yt-dlp ${args}`, {
    timeout: 120000,
    maxBuffer: 10 * 1024 * 1024
  });
  return stdout;
}

app.get('/api/info', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'URL required' });
  try {
    const raw = await runYtDlp(`--dump-json --no-playlist "${url}"`);
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
        if (!seen.has(key) && result.formats.filter(x=>x.type==='video').length < 4) {
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

app.get('/api/proxy', (req, res) => {
  const url = req.query.url;
  const filename = req.query.filename || 'download';
  if (!url) return res.status(400).json({ error: 'URL required' });
  const protocol = url.startsWith('https') ? https : http;
  protocol.get(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': 'https://www.google.com/'
    }
  }, (response) => {
    if (response.statusCode === 301 || response.statusCode === 302) {
      const red = response.headers.location;
      const rp = red.startsWith('https') ? https : http;
      rp.get(red, (r2) => {
        res.setHeader('Content-Type', r2.headers['content-type'] || 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        if (r2.headers['content-length']) res.setHeader('Content-Length', r2.headers['content-length']);
        r2.pipe(res);
      });
      return;
    }
    res.setHeader('Content-Type', response.headers['content-type'] || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    if (response.headers['content-length']) res.setHeader('Content-Length', response.headers['content-length']);
    response.pipe(res);
  }).on('error', (e) => res.status(500).json({ error: e.message }));
});

app.listen(PORT, () => console.log(`PhantDL Backend running on port ${PORT}`));
