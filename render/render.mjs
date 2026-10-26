// Рендер эпизодов «Битвы стран» в вертикальное MP4 1080×1920 для TikTok/Shorts.
// Игра идёт в headless Chrome в режиме ?render=1 (кубики по зерну, без вмешательства), экран пишется через
// CDP Page.startScreencast, музыка и звуки сводятся в самой странице (OfflineAudioContext) по таймкодам событий,
// диктор — edge-tts, склейка — ffmpeg.
//
//   node render/render.mjs --map europe --episodes 3 --speed 3 [--lang ru] [--seed abc] [--ep 1]
//                          [--out out] [--no-voice] [--chrome path/to/chrome.exe] [--scale 1.5]
//
// Нужны: Node 22+, ffmpeg в PATH, Chrome/Chromium (или chrome-headless-shell), для голоса — `py -m pip install edge-tts`.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn, execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i < 0 ? d : (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true); };
const MAP = arg('map', 'europe'), LANG = arg('lang', 'ru'), SPEED = +arg('speed', 3), EPISODES = +arg('episodes', 1);
const EP0 = +arg('ep', 1), SEED = arg('seed', null), OUT = path.resolve(arg('out', path.join(ROOT, 'out')));
const VOICE = !process.argv.includes('--no-voice'), SCALE = +arg('scale', 1.5), MAX_MIN = +arg('max-minutes', 40);
const TTS_VOICE = arg('voice', LANG === 'en' ? 'en-US-GuyNeural' : 'ru-RU-DmitryNeural');
const MAP_NAMES = {world: ['Мир', 'World'], europe: ['Европа', 'Europe'], asia: ['Азия', 'Asia'], africa: ['Африка', 'Africa'],
  americas: ['Америка', 'Americas'], usa: ['Штаты США', 'US States'], russia: ['Регионы России', 'Regions of Russia']};
if (!MAP_NAMES[MAP]) throw new Error('Неизвестная карта: ' + MAP);
const SR = 22050, W = 720, H = 1280;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function findChrome() {
  const cands = [arg('chrome', null), process.env.CHROME,
    path.resolve(ROOT, '../../Remotion/node_modules/.remotion/chrome-headless-shell/win64/chrome-headless-shell-win64/chrome-headless-shell.exe'),
    'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/chromium', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean);
  const hit = cands.find(p => fs.existsSync(p));
  if (!hit) throw new Error('Не найден Chrome: укажите --chrome путь');
  return hit;
}

// статический сервер для папки игры
function serve() {
  const types = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css'};
  const srv = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = path.join(ROOT, p === '/' ? 'index.html' : p);
    if (!file.startsWith(ROOT)) return res.writeHead(403).end();
    fs.readFile(file, (err, data) => err ? res.writeHead(404).end() : res.writeHead(200, {'Content-Type': types[path.extname(file)] || 'application/octet-stream'}).end(data));
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv)));
}

// минимальный клиент Chrome DevTools Protocol
async function launch() {
  const port = 9600 + Math.floor(Math.random() * 300);
  const prof = path.join(OUT, '.chrome-profile');
  const proc = spawn(findChrome(), ['--headless=new', '--no-sandbox', `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, `--window-size=${W},${H}`,
    '--hide-scrollbars', '--mute-audio', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows', '--force-color-profile=srgb', 'about:blank'], {stdio: 'ignore'});
  let list;
  for (let i = 0; i < 100; i++) { try { list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); if (list.length) break; } catch {} await sleep(200); }
  const ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const pend = {}, handlers = {};
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pend[m.id]) { pend[m.id](m); delete pend[m.id]; }
    else if (m.method && handlers[m.method]) handlers[m.method](m.params);
  };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pend[i] = r; ws.send(JSON.stringify({id: i, method, params})); });
  const evaluate = async expr => {
    const r = await send('Runtime.evaluate', {expression: expr, returnByValue: true, awaitPromise: true});
    if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
    return r.result.result.value;
  };
  return {proc, ws, send, evaluate, on: (ev, f) => { handlers[ev] = f; }};
}

function wav(pcm, sr) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length * 2, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(sr, 24); h.writeUInt32LE(sr * 2, 28);
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length * 2, 40);
  return Buffer.concat([h, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)]);
}
// реплика диктора: edge-tts → PCM 22050 моно (с кешем)
function tts(text, dir) {
  const key = crypto.createHash('sha1').update(TTS_VOICE + text).digest('hex').slice(0, 16);
  const mp3 = path.join(dir, key + '.mp3');
  if (!fs.existsSync(mp3)) {
    // сервис edge-tts иногда отвечает пустотой на серию запросов: повторяем с растущей паузой
    const tmp = mp3 + '.part';
    for (let a = 1; ; a++) {
      try {
        execFileSync('py', ['-m', 'edge_tts', '--voice', TTS_VOICE, '--rate=+8%', '--text', text, '--write-media', tmp], {stdio: 'ignore'});
        if (fs.statSync(tmp).size > 2000) { fs.renameSync(tmp, mp3); break; }
      } catch {}
      fs.rmSync(tmp, {force: true});
      if (a >= 6) { console.warn('  реплика пропущена (edge-tts не ответил):', text); return null; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500 * 2 ** (a - 1));
    }
  }
  try {
    const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', mp3, '-af', 'loudnorm=I=-16:TP=-1.5', '-f', 's16le', '-ac', '1', '-ar', String(SR), '-'], {maxBuffer: 1 << 28});
    return new Int16Array(raw.buffer, raw.byteOffset, raw.length >> 1);
  } catch { fs.rmSync(mp3, {force: true}); return null; }
}

// реплики группами по 10 одним запросом к edge-tts: каждая реплика — одно предложение, режем по таймкодам субтитров.
// Длинный текст сервис дробит сам, и любая из частей может сорваться, поэтому группы короткие.
function ttsGroup(lines, dir) {
  const sents = lines.map(t => t.replace(/[.!?:]+\s+/g, ', ').replace(/[.!?…\s]*$/, '.'));
  const key = crypto.createHash('sha1').update(TTS_VOICE + sents.join('|')).digest('hex').slice(0, 16);
  const mp3 = path.join(dir, `group-${key}.mp3`), srt = path.join(dir, `group-${key}.srt`);
  if (!fs.existsSync(mp3) || !fs.existsSync(srt)) {
    for (let a = 1; ; a++) {
      try { execFileSync('py', ['-m', 'edge_tts', '--voice', TTS_VOICE, '--rate=+8%', '--text', sents.join(' '), '--write-media', mp3, '--write-subtitles', srt], {stdio: 'ignore'}); if (fs.statSync(mp3).size > 2000) break; } catch {}
      fs.rmSync(mp3, {force: true}); fs.rmSync(srt, {force: true});
      if (a >= 8) return null;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000 * a);
    }
  }
  const sec = s => { const [h, m, r] = s.trim().split(':'); return +h * 3600 + +m * 60 + +r.replace(',', '.'); };
  const cues = fs.readFileSync(srt, 'utf8').trim().split(/\r?\n\r?\n/).map(b => b.split(/\r?\n/)[1].split(' --> ').map(sec));
  if (cues.length !== lines.length) return null;
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', mp3, '-af', 'loudnorm=I=-16:TP=-1.5', '-f', 's16le', '-ac', '1', '-ar', String(SR), '-'], {maxBuffer: 1 << 28});
  const all = new Int16Array(raw.buffer, raw.byteOffset, raw.length >> 1);
  return cues.map(([a, b], k) => all.slice(Math.max(0, Math.round((a - 0.03) * SR)), Math.min(all.length, Math.round((Math.min(b + 0.12, cues[k + 1] ? cues[k + 1][0] : b + 0.3)) * SR))));
}
function ttsBatch(lines, dir) {
  const out = [];
  let ok = 0;
  for (let i = 0; i < lines.length; i += 10) {
    const g = ttsGroup(lines.slice(i, i + 10), dir);
    for (let k = 0; k < Math.min(10, lines.length - i); k++) out.push(g ? g[k] : null);
    if (g) ok++;
  }
  console.log(`  озвучка: групп ${Math.ceil(lines.length / 10)}, получено ${ok}`);
  return out;
}

async function renderEpisode(cdp, port, ep, seed) {
  const ru = LANG !== 'en';
  const title = `${ru ? 'Битва стран' : 'Battle of Nations'} — ${MAP_NAMES[MAP][ru ? 0 : 1]} — ${ru ? 'эпизод' : 'episode'} ${ep}`;
  const work = path.join(OUT, `.work-${MAP}-${ep}`);
  fs.rmSync(work, {recursive: true, force: true}); fs.mkdirSync(path.join(work, 'f'), {recursive: true});
  const ttsDir = path.join(OUT, '.tts'); fs.mkdirSync(ttsDir, {recursive: true});
  console.log(`\n▶ ${title} · зерно ${seed} · скорость ${SPEED}×`);

  await cdp.send('Emulation.setDeviceMetricsOverride', {width: W, height: H, deviceScaleFactor: SCALE, mobile: false});
  await cdp.send('Page.navigate', {url: `http://127.0.0.1:${port}/?render=1&map=${MAP}&lang=${LANG}&speed=${SPEED}&seed=${encodeURIComponent(seed)}&ep=${ep}`});
  for (let i = 0; i < 300; i++) { await sleep(200); if (await cdp.evaluate('!!window.__ready').catch(() => false)) break; }
  await sleep(2500); // флаги прогружаются

  const frames = [];
  cdp.on('Page.screencastFrame', p => {
    const f = path.join(work, 'f', String(frames.length).padStart(6, '0') + '.jpg');
    fs.writeFileSync(f, Buffer.from(p.data, 'base64'));
    frames.push({f, ts: p.metadata.timestamp});
    cdp.send('Page.screencastFrameAck', {sessionId: p.sessionId});
  });
  await cdp.send('Page.startScreencast', {format: 'jpeg', quality: 90, maxWidth: Math.round(W * SCALE), maxHeight: Math.round(H * SCALE), everyNthFrame: 1});
  await sleep(300);
  await cdp.evaluate('window.__go(), 1');
  const tStart = Date.now();
  let last = 0;
  while (!(await cdp.evaluate('!!window.__done'))) {
    await sleep(2000);
    if (Date.now() - last > 15000) { last = Date.now(); console.log(`  ${await cdp.evaluate("document.querySelector('#title').textContent")} · кадров ${frames.length}`); }
    if (Date.now() - tStart > MAX_MIN * 60000) throw new Error('Эпизод не уложился в ' + MAX_MIN + ' мин');
  }
  await sleep(500);
  await cdp.send('Page.stopScreencast');
  if (frames.length < 10) throw new Error('Слишком мало кадров: ' + frames.length);

  // видеоряд: длительность каждого кадра — до следующего
  const tail = 1.5, v0 = frames[0].ts, vEnd = frames.at(-1).ts + tail, dur = vEnd - v0;
  let list = '';
  frames.forEach((fr, i) => { list += `file '${fr.f.replace(/\\/g, '/')}'\nduration ${((i + 1 < frames.length ? frames[i + 1].ts : vEnd) - fr.ts).toFixed(4)}\n`; });
  list += `file '${frames.at(-1).f.replace(/\\/g, '/')}'\n`;
  fs.writeFileSync(path.join(work, 'frames.txt'), list);
  console.log(`  записано ${frames.length} кадров, ${dur.toFixed(1)} с (≈${(frames.length / dur).toFixed(1)} fps)`);

  // игровой звук: музыка + эффекты, сведённые в странице
  const t0 = await cdp.evaluate('window.__t0'), off = t0 - v0;
  const len = await cdp.evaluate(`window.__renderAudio(${(dur - off).toFixed(3)}, ${t0})`);
  let b64 = '';
  for (let i = 0; i < len; i += 4e6) b64 += await cdp.evaluate(`window.__pcm.slice(${i}, ${i + 4e6})`);
  const gb = Buffer.from(b64, 'base64'), game = new Int16Array(gb.buffer, gb.byteOffset, gb.length >> 1);
  const total = Math.ceil(dur * SR), mix = new Float32Array(total), duck = new Float32Array(total).fill(1);
  const o0 = Math.round(off * SR);

  // диктор: реплики не перекрываются; запоздавшие больше чем на 2.5 с пропускаются
  let speech = 0;
  if (VOICE) {
    const events = await cdp.evaluate('window.__events.filter(e => e.say)');
    const batch = ttsBatch(events.map(e => e.say), ttsDir);
    let free = 0;
    for (const [k, e] of events.entries()) {
      const want = e.t - v0, start = Math.max(want, free), must = k === 0 || k === events.length - 1;
      if (start - want > 2.5 && !must) continue;
      const v = batch[k] || tts(e.say, ttsDir); if (!v || !v.length) continue;
      const s0 = Math.round(start * SR);
      for (let i = 0; i < v.length && s0 + i < total; i++) { mix[s0 + i] += v[i] / 32768; duck[s0 + i] = 0.4; }
      free = start + v.length / SR + 0.15; speech++;
    }
    // плавное приглушение игры под голосом
    for (let i = 1; i < total; i++) duck[i] = duck[i] < duck[i - 1] ? duck[i - 1] - (duck[i - 1] - duck[i]) * 0.002 : duck[i - 1] + (duck[i] - duck[i - 1]) * 0.0005;
  }
  for (let i = 0; i < game.length && o0 + i < total; i++) if (o0 + i >= 0) mix[o0 + i] += (game[i] / 32768) * 0.8 * duck[o0 + i];
  const pcm = new Int16Array(total);
  for (let i = 0; i < total; i++) pcm[i] = Math.max(-1, Math.min(1, mix[i])) * 32767;
  fs.writeFileSync(path.join(work, 'mix.wav'), wav(pcm, SR));
  console.log(`  звук сведён: реплик диктора ${speech}`);

  fs.mkdirSync(OUT, {recursive: true});
  const mp4 = path.join(OUT, title + '.mp4'), cover = path.join(OUT, title + ' — обложка.jpg');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', path.join(work, 'frames.txt'), '-i', path.join(work, 'mix.wav'),
    '-vf', 'scale=1080:1920:flags=lanczos,fps=30,format=yuv420p', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
    '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11', '-c:a', 'aac', '-b:a', '192k', '-ar', '44100', '-shortest', '-movflags', '+faststart', mp4], {stdio: 'inherit'});
  // обложка — заставка «Кто победит?»: последний кадр в первые 2 секунды (кадры приходят только при изменениях)
  const cf = frames.filter(fr => fr.ts - v0 <= 2).at(-1) || frames[0];
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', cf.f, '-vf', 'scale=1080:1920:flags=lanczos', '-q:v', '2', cover]);
  fs.rmSync(work, {recursive: true, force: true});
  console.log(`  ✓ ${mp4}\n  ✓ ${cover}`);
  return mp4;
}

const srv = await serve();
const port = srv.address().port;
fs.mkdirSync(OUT, {recursive: true});
const cdp = await launch();
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
try {
  for (let k = 0; k < EPISODES; k++) {
    const seed = SEED && EPISODES === 1 ? SEED : (SEED ? `${SEED}-${k + 1}` : crypto.randomBytes(4).toString('hex'));
    await renderEpisode(cdp, port, EP0 + k, seed);
  }
} finally {
  cdp.ws.close(); cdp.proc.kill(); srv.close();
}
