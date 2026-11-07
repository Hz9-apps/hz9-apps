'use strict';
/**
 * 100-200 Timer - rolling-start acceleration timer drawn in the HMI's style.
 *
 *   Drive below 100 km/h -> ARMED. Floor it: the clock starts the moment you pass 100 and stops at 200.
 *   Crossings are interpolated between speed samples. Lifting (5 km/h under the run's peak) or
 *   dropping under 100 throws the run away. Other ranges (80-120, 100-150, 60-100, 200-250) and mph in Settings.
 *
 * Pages: live run  /  best times + recent runs (saved in data/wz_100200_runs.json)
 * Speed: Vehicle2.statusCarSpeed2 (centre-of-gravity speed: true speed, like a GPS box, not the speedo).
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const { withAlpha } = require('./kit/canvas');
const G = require('./kit/gauges');
const { RollTimer, ARM_MARGIN } = require('./timer');
const Demo = require('./demo');

const W = 1600, H = 520;
const MPH = 1.609344;
const GO = '#2fd27a';

/** Every range in both units; speeds in km/h internally. */
const m = (x) => x * MPH;
const RANGES = {
    r100_200: { kmh: { from: 100, to: 200, marks: [125, 150, 175] }, mph: { from: m(60), to: m(130), marks: [m(80), m(100), m(120)] } },
    r80_120: { kmh: { from: 80, to: 120, marks: [90, 100, 110] }, mph: { from: m(50), to: m(75), marks: [m(55), m(60), m(70)] } },
    r100_150: { kmh: { from: 100, to: 150, marks: [125] }, mph: { from: m(60), to: m(100), marks: [m(80)] } },
    r60_100: { kmh: { from: 60, to: 100, marks: [80] }, mph: { from: m(40), to: m(60), marks: [m(50)] } },
    r200_250: { kmh: { from: 200, to: 250, marks: [225] }, mph: { from: m(125), to: m(155), marks: [m(140)] } },
};

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const S = (ctx.spec.config && ctx.spec.config.scaling) || {};
        const sc = (k, raw) => {
            const c = S[k];
            if (!c || raw === undefined || raw === null || raw === c.invalid) return null;
            return raw * c.factor + (c.offset || 0);
        };

        /* ---------- units / format ---------- */
        const unit = () => (settings.get('speedUnit') === 'mph' ? 'mph' : 'kmh');
        const mph = () => unit() === 'mph';
        const V = (k) => (k == null ? null : mph() ? k / MPH : k);
        const vU = () => (mph() ? 'mph' : 'km/h');
        const rangeKey = () => (RANGES[settings.get('range')] ? settings.get('range') : 'r100_200');
        const rangeOf = (key, u) => RANGES[key][u || unit()];
        const range = () => rangeOf(rangeKey());
        const R = (k) => Math.round(V(k));
        const rangeName = (key, u) => { const r = rangeOf(key || rangeKey(), u); const f = u ? (u === 'mph' ? (x) => Math.round(x / MPH) : Math.round) : R; return f(r.from) + '-' + f(r.to); };
        const bestKey = (key, u) => (u || unit()) + ':' + (key || rangeKey());
        const secs = (s) => (G.isNum(s) ? s.toFixed(2) : '--.--');
        const when = (ms) => { const d = new Date(ms); const p = (n) => String(n).padStart(2, '0'); return p(d.getDate()) + '.' + p(d.getMonth() + 1) + '. ' + p(d.getHours()) + ':' + p(d.getMinutes()); };

        /* ---------- saved runs ---------- */
        const FILE = path.join(ctx.dataDir, 'wz_100200_runs.json');
        let saved = { best: {}, runs: [] };
        try { saved = Object.assign(saved, JSON.parse(fs.readFileSync(FILE, 'utf8'))); } catch (e) { /* first start */ }
        const demoStore = { best: {}, runs: [] };          // demo runs are shown but never saved
        let store = saved;
        const save = () => { if (store !== saved) return; try { fs.writeFileSync(FILE, JSON.stringify(saved)); } catch (e) { log.warn('save runs: ' + e); } };

        /* ---------- timer ---------- */
        let newBest = false, prevBest = null, peakG = 0;
        const onDone = (run) => {
            const k = bestKey(), b = store.best[k];
            prevBest = b ? b.s : null;
            newBest = !b || run.total < b.s;
            if (newBest) store.best[k] = { s: run.total, at: run.at, segs: run.segs, dist: run.dist };
            store.runs.unshift({ at: run.at, range: rangeKey(), unit: unit(), s: run.total, segs: run.segs, dist: run.dist, peakG });
            store.runs = store.runs.slice(0, 30);
            save();
            log.info('run done ' + rangeName() + ' ' + run.total.toFixed(2) + ' s');
        };
        let timer;
        const newTimer = () => {
            store = feedDemo ? demoStore : saved;
            timer = new RollTimer(range(), { onDone, onStart: () => { peakG = 0; newBest = false; prevBest = null; } });
            newBest = false; prevBest = null;
        };

        /* ---------- live data ---------- */
        const live = { speed: null, g: null };
        let lastCar = 0, feedDemo = false, speedSub = null;
        const demo = new Demo(), t0 = Date.now();
        const carPresent = () => lastCar > 0 || !!(speedSub && speedSub.available);
        const usingDemo = () => settings.get('demo') === 'on' || (settings.get('demo') === 'auto' && !carPresent() && Date.now() - t0 > 5000);
        newTimer();

        ctx.signals.watch('de.bmw.infotainment.vehicle.Vehicle2', '1', {
            statusCarSpeed2: (v) => {
                const kmh = sc('speed', v.speedVehicleCentreOfGravity);
                if (kmh === null) return;
                lastCar = Date.now(); live.speed = kmh;
                if (!feedDemo) timer.feed(lastCar, kmh);
            },
        }, log).then((s) => { speedSub = s; log.info('speed signal ' + (s.error ? 'error ' + s.error : 'subscribed')); return s; });
        ctx.signals.watch('de.bmw.infotainment.vehicle.CDS2', '1', {
            statusLongitudinalAccelerationMassCenter: (v) => {
                const a = sc('accel', v.longitudinalAccelerationCentreOfGravity);
                if (a === null) return;
                live.g = a / 9.80665;
                if (timer.state === 'run' && !feedDemo) peakG = Math.max(peakG, live.g);
            },
        }, log);

        // demo feed at 20 Hz; switching source starts clean
        let prevV = null;
        setInterval(() => {
            const d = usingDemo();
            if (d !== feedDemo) { feedDemo = d; newTimer(); log.info(d ? 'demo data on' : 'live speed'); }
            const now = Date.now();
            if (!feedDemo) { timer.idle(now); return; }
            const v = demo.speed(now, range());
            live.g = prevV === null ? 0 : (v - prevV) / 3.6 / 0.05 / 9.80665; prevV = v;
            live.speed = v;
            timer.feed(now, v);
            timer.idle(now);
            if (timer.state === 'run') peakG = Math.max(peakG, live.g);
        }, 50);

        /* ---------- drawing ---------- */
        let page = 0;
        const stateLine = () => {
            const r = range();
            if (timer.state === 'run') return ['TIMING', 'accent'];
            if (timer.state === 'ready') return ['ARMED - FLOOR IT', 'go'];
            return ['SLOW BELOW ' + Math.floor(V(r.from - ARM_MARGIN)) + ' ' + vU().toUpperCase() + ' TO ARM', 'dim'];
        };

        function header(cv, t) {
            G.frame(cv, t, [rangeName() + ' ' + vU(), 'Best times'], page, [feedDemo && { text: 'DEMO' }]);
        }

        function drawRun(cv, t) {
            const now = Date.now(), r = range();
            const [stTxt, stCol] = stateLine();
            const col = stCol === 'go' ? GO : t[stCol];
            // --- speed + clock ---
            const sh = G.panel(cv, t, 24, 44, 520, 468, 'Speed'), ex = sh.y + sh.h - G.BOTTOM, mid = Math.round(ex / 2);
            const sp = V(G.hold('speed', live.speed, 1000 / settings.get('speedRate')));
            cv.text(G.fmt(sp, 0), 460, 227, 150, G.isNum(sp) ? t.text : t.dim, { align: 'right', font: 'num' });
            cv.text(vU(), 476, 227, 28, t.dim);
            cv.fillRect(44, 255, 480, 2, t.panelEdge);
            const el = timer.elapsed(now), eb = G.toMargin(ex, 8), es = mid + eb - ex;
            const done = timer.last && timer.last.ok && timer.state !== 'run';
            cv.text(secs(el), 400, 384 + es, 96, timer.state === 'run' ? t.text : done ? (newBest ? GO : t.accent2) : t.dim, { align: 'right', font: 'num' });
            cv.text('s', 412, 384 + es, 32, t.dim);
            cv.roundRect(44, 412 + es, 480, 44, 8, withAlpha(col, 0.18));
            if (timer.state === 'ready') cv.roundRect(44, 412 + es, 480, 44, 8, withAlpha(GO, 0.35 + 0.25 * Math.sin(now / 160)));
            cv.text(stTxt, 284, 446 + es, stTxt.length > 22 ? 22 : 26, col, { align: 'center', font: 'bold', spacing: stTxt.length > 22 ? 1 : 3 });
            let foot = 'PEAK ' + (peakG > 0 ? peakG.toFixed(2) : '-.--') + ' g';
            if (timer.last && !timer.last.ok && timer.state !== 'run') foot = 'ABORTED: ' + timer.last.reason.replace(/(\d+) km\/h/, (_, k) => R(Number(k)) + ' ' + vU()).toUpperCase();
            cv.text(foot, 44, 493 + eb, 22, timer.last && !timer.last.ok && timer.state !== 'run' ? t.accent : t.dim, { font: 'bold', spacing: 1 });
            G.button(cv, t, 384, 466 + eb, 140, 38, 'Reset run', act, { key: 'reset' });

            // --- speed trace ---
            G.panel(cv, t, 568, 44, 520, 468, 'Speed trace');
            const px = 640, py = 104, pw = 424, ph = 351 + G.toMargin(ex, 31);
            const tr = timer.trace;
            const tMax = Math.max(6, Math.ceil(tr.length ? tr[tr.length - 1][0] / 2 + 0.5 : 0) * 2);
            const lo = V(r.from) - (mph() ? 10 : 20), hi = V(r.to) + (mph() ? 10 : 20);
            const X = (s) => px + (s / tMax) * pw, Y = (v) => py + ph - ((v - lo) / (hi - lo)) * ph;
            [r.from].concat(r.marks, [r.to]).forEach((k, i, a) => {
                const yy = Y(V(k)), edge = i === 0 || i === a.length - 1;
                cv.fillRect(px, yy, pw, edge ? 2 : 1, withAlpha(edge ? t.accent2 : t.tick, edge ? 0.6 : 0.35));
                cv.text(String(R(k)), px - 10, yy + 8, 20, edge ? t.text : t.dim, { align: 'right' });
            });
            const step = tMax > 30 ? 10 : tMax > 12 ? 4 : 2;
            for (let s = 0; s <= tMax; s += step) cv.text(s + 's', X(s), py + ph + 26, 20, t.dim, { align: 'center' });
            if (tr.length > 1) {
                const pts = tr.map(([s, v]) => [X(s), Y(Math.max(lo, Math.min(hi, V(v))))]);
                cv.fillUnder(pts, py + ph, withAlpha(t.accent, 0.16));
                cv.polyline(pts, 3, t.accent);
                [r.from].concat(r.marks, [r.to]).forEach((k) => {
                    if (timer.cross[k] === undefined) return;
                    const x = X(timer.cross[k]), y = Y(V(k));
                    cv.circle(x, y, 7, t.text);
                    cv.circle(x, y, 4, t.accent);
                });
            } else {
                cv.text(timer.state === 'ready' ? 'Floor it - the clock starts at ' + R(r.from) : 'Get below ' + R(r.from) + ' ' + vU() + ' to arm',
                    px + pw / 2, py + ph / 2, 26, t.dim, { align: 'center' });
            }

            // --- splits ---
            G.panel(cv, t, 1112, 44, 464, 468, 'Splits');
            const segs = timer.segments(), best = store.best[bestKey()];
            const rows = segs.map((s, i) => ({ label: R(s.from) + '-' + R(s.to) + ' ' + vU(), s: s.s, b: best && best.segs ? best.segs[i] : null }));
            const n = rows.length + 1, gap = n > 3 ? 64 : 80;
            rows.forEach((row, i) => {
                const y = 96 + i * gap;
                cv.text(row.label, 1136, y + 20, 22, t.dim, { font: 'bold', spacing: 0.5 });
                cv.text(secs(row.s), 1520, y + 26, 36, G.isNum(row.s) ? t.text : withAlpha(t.dim, 0.6), { align: 'right', font: 'num' });
                cv.text('s', 1528, y + 26, 20, t.dim);
                if (G.isNum(row.b)) cv.text('best run ' + secs(row.b), 1136, y + 46, 20, t.dim, { font: 'label' });
                cv.fillRect(1136, y + gap - 10, 416, 1, withAlpha(t.tick, 0.35));
            });
            // total
            const y = 96 + rows.length * gap + 4 + Math.max(0, G.toMargin(ex, 0));
            const total = timer.total;
            cv.text(rangeName() + ' ' + vU(), 1136, y + 26, 26, t.text, { font: 'bold', spacing: 0.5 });
            cv.text(secs(total), 1520, y + 46, 54, G.isNum(total) ? (newBest ? GO : t.accent2) : withAlpha(t.dim, 0.6), { align: 'right', font: 'num' });
            cv.text('s', 1528, y + 46, 22, t.dim);
            let sub = best ? 'best ' + secs(best.s) : 'no best yet', subCol = t.dim;
            if (G.isNum(total) && newBest) { sub = prevBest ? 'NEW BEST  -' + (prevBest - total).toFixed(2) : 'NEW BEST'; subCol = GO; } else if (G.isNum(total) && best) {
                const d = total - best.s; sub = (d >= 0 ? '+' : '') + d.toFixed(2) + '  vs best ' + secs(best.s); subCol = d <= 0 ? GO : t.dim;
            }
            cv.text(sub, 1136, y + 78, 22, subCol, { font: 'label' });
            if (G.isNum(total) && timer.last && G.isNum(timer.last.dist)) cv.text(Math.round(timer.last.dist) + ' m', 1552, y + 78, 22, t.dim, { align: 'right' });
        }

        function drawBest(cv, t) {
            const keys = Object.keys(RANGES);
            const sh = G.panel(cv, t, 24, 44, 640, 468, 'Best times (' + vU() + ')'), ex = sh.y + sh.h - G.BOTTOM;
            G.button(cv, t, 664 - 20 - 200, 56, 200, 40, clearArmed ? 'Yes, clear' : 'Reset best', act, { key: 'clear', color: clearArmed ? t.crit : null });
            keys.forEach((k, i) => {
                const rowH = 72;      // five tests in the panel (more room where the page reaches lower)
                const y = Math.round(92 + (cv.extra ? 25 : 0) + i * (rowH + Math.max(0, ex - 25) / keys.length)), b = store.best[bestKey(k)];
                const cur = k === rangeKey();
                cv.text(rangeName(k, unit()) + ' ' + vU(), 48, y + 30, 26, cur ? t.text : t.dim, { font: 'bold' });
                cv.text(b ? secs(b.s) : '--.--', 560, y + 38, 46, b ? t.accent2 : t.dim, { align: 'right', font: 'num' });
                cv.text('s', 568, y + 38, 22, t.dim);
                if (b) cv.text(when(b.at) + (G.isNum(b.dist) ? '  ·  ' + Math.round(b.dist) + ' m' : ''), 48, y + 56, 20, t.dim);
                if (i < keys.length - 1) cv.fillRect(48, y + 64, 592, 1, withAlpha(t.tick, 0.35));
            });

            G.panel(cv, t, 688, 44, 888, 468, 'Recent runs');
            const cx = [712, 980, 1240, 1400, 1552];
            ['WHEN', 'TEST', 'TIME', 'DIST', 'PEAK G'].forEach((h, i) => cv.text(h, cx[i], 127, 22, t.dim, { align: i < 2 ? 'left' : 'right', font: 'bold', spacing: 1 }));
            const runs = store.runs.filter((r) => r.unit === unit()).slice(0, 8 + Math.floor(ex / 41));
            if (!runs.length) cv.text('No runs yet - get below ' + R(range().from) + ', floor it, and they show up here.', 712, 221, 24, t.dim);
            runs.forEach((r, i) => {
                const y = 176 + i * 41, b = store.best[bestKey(r.range, r.unit)];
                cv.text(when(r.at), cx[0], y, 24, t.text);
                cv.text(rangeName(r.range, r.unit), cx[1], y, 24, t.text);
                cv.text(secs(r.s), cx[2], y, 28, b && Math.abs(b.s - r.s) < 1e-9 ? GO : t.text, { align: 'right', font: 'num' });
                cv.text(G.isNum(r.dist) ? Math.round(r.dist) + ' m' : '--', cx[3], y, 24, t.dim, { align: 'right' });
                cv.text(r.peakG > 0 ? r.peakG.toFixed(2) : '--', cx[4], y, 24, t.dim, { align: 'right' });
                if (i < runs.length - 1) cv.fillRect(712, y + 12, 840, 1, withAlpha(t.tick, 0.25));
            });
        }

        async function render() {
            const t = ctx.theme();
            const cv = ctx.canvas(W, H).clear(t.bg);
            (page === 0 ? drawRun : drawBest)(cv, t);
            header(cv, t);
            await ui.image('MAIN_GFX', cv);
        }

        /* ---------- buttons ---------- */
        let clearArmed = null;
        const actionLabel = () => ui.text('BTN_ACTION', page === 0 ? 'Reset run' : clearArmed ? 'Yes, clear' : 'Reset best');
        const flip = () => { page = 1 - page; actionLabel(); return render(); };
        ui.onClick('BTN_PAGE', flip);
        ui.onClick('BTN_PREV', flip);
        ctx.onTab((i) => i !== page && flip());
        // Reset run (live page) / Reset best, pressed twice (Best times page)
        function act() {
            if (page === 0) { timer.reset(); peakG = 0; newBest = false; return render(); }
            if (!clearArmed) {
                clearArmed = setTimeout(() => { clearArmed = null; actionLabel(); }, 5000);
                return actionLabel();
            }
            clearTimeout(clearArmed); clearArmed = null;
            store.best = {}; store.runs = []; save();
            log.info('best times cleared');
            actionLabel();
            return render();
        }
        ui.onClick('BTN_ACTION', act);
        ctx.hideButton('BTN_ACTION');

        ctx.loop('MAIN', 8, render);
        settings.onChange((k) => { if (k === 'speedUnit' || k === 'range') { newTimer(); peakG = 0; } });
        render().then(() => log.info('first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});
