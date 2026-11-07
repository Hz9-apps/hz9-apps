'use strict';
/**
 * Rolling-start timer (100-200 km/h and friends).
 *
 * Feed it (time ms, speed km/h) samples. States:
 *   wait  - at or above the start speed: slow down below it to arm
 *   ready - below the start speed (by ARM_MARGIN), armed
 *   run   - the start speed was crossed going up; timing until the end speed
 * Crossing times are interpolated between samples, so results don't depend on the sample rate.
 * A run is thrown away (aborted) when you lift (speed drops LIFT_KMH below the run's peak), fall back
 * under the start speed, or after MAX_RUN_MS. A finished or aborted run goes back to 'wait'.
 */
const ARM_MARGIN = 3;        // must be this far under the start speed to arm (no false starts hovering at 100)
const LIFT_KMH = 5;          // a drop this far below the run's peak ends it
const MAX_RUN_MS = 60000;    // 60 s limit
const STALE_MS = 500;        // no new sample for this long = speed unchanged (signals come on change)

/** range: { from, to, marks: [km/h, ...] } all km/h, marks between from and to. */
class RollTimer {
    constructor(range, opts) {
        this.range = range;
        this.onDone = (opts && opts.onDone) || (() => {});
        this.onStart = (opts && opts.onStart) || (() => {});
        this.state = 'wait';
        this.prev = null;
        this.last = null;            // last finished or aborted run, kept on screen
        this.clear();
    }

    clear() {
        this.t0 = null; this.dist = 0; this.vmax = 0; this.trace = []; this.endAt = undefined;
        this.cross = {};             // km/h -> run time (s)
        this.total = undefined;      // from -> to, seconds
    }

    /** Points of the run: from, every mark, to. */
    points() { return [this.range.from].concat(this.range.marks || [], [this.range.to]); }

    reset() { this.clear(); this.last = null; this.state = this.prev && this.prev.v <= this.range.from - ARM_MARGIN ? 'ready' : 'wait'; }

    elapsed(now) {
        if (this.state === 'run' && this.t0 !== null) return (now - this.t0) / 1000;
        if (this.endAt !== undefined) return this.endAt;
        return 0;
    }

    feed(t, v) {
        const p = this.prev;
        if (v === null || v === undefined || !isFinite(v)) return;
        this.prev = { t, v };
        const { from } = this.range;
        if (this.state !== 'run') {
            if (v <= from - ARM_MARGIN) { this.state = 'ready'; return; }
            if (this.state === 'ready' && v >= from && p && p.v < from) { this._start(p, { t, v }); return; }
            if (v >= from) this.state = 'wait';
            return;
        }
        if (p) this._step(p, { t, v });
    }

    /**
     * Call every ~50 ms. Speed comes on change: a car holding a steady 90 sends nothing, so an old
     * sample is carried forward to now (the start crossing is then interpolated from a fresh point,
     * not from one seconds old), and the run's time limit is checked by the clock.
     */
    idle(now) {
        const p = this.prev;
        if (this.state === 'run') {
            if (now - this.t0 > MAX_RUN_MS) this._finish(now, 'time limit');
            return;
        }
        if (p && now - p.t > STALE_MS) this.prev = { t: now - STALE_MS, v: p.v };
    }

    _start(p, c) {
        this.clear();
        this.state = 'run';
        const { from } = this.range;
        const f = c.v > p.v ? (from - p.v) / (c.v - p.v) : 1;
        this.t0 = p.t + Math.max(0, Math.min(1, f)) * (c.t - p.t);
        this.cross[from] = 0;
        this.trace.push([0, from]);
        this.onStart();
        this._step({ t: this.t0, v: from }, c);
    }

    _step(p, c) {
        const dt = (c.t - p.t) / 1000;
        if (dt <= 0) return;
        this.dist += ((p.v + c.v) / 2 / 3.6) * dt;
        const rt = (x) => (x - this.t0) / 1000;
        this.vmax = Math.max(this.vmax, c.v);
        const lastPt = this.trace[this.trace.length - 1];
        if (!lastPt || rt(c.t) - lastPt[0] >= 0.05) this.trace.push([rt(c.t), c.v]);
        if (this.trace.length > 1800) this.trace = this.trace.filter((_, i) => i % 2 === 0);

        for (const target of this.points()) {
            if (this.cross[target] !== undefined || c.v < target) continue;
            const f = c.v > p.v && p.v < target ? (target - p.v) / (c.v - p.v) : 0;
            this.cross[target] = rt(p.t + f * (c.t - p.t));
            if (target === this.range.to) this.distAtEnd = this.dist - ((c.v + target) / 2 / 3.6) * (1 - f) * dt;
        }
        if (this.cross[this.range.to] !== undefined) return this._finish(c.t, null);
        if (c.v < this.vmax - LIFT_KMH) return this._finish(c.t, 'lifted at ' + Math.round(this.vmax) + ' km/h');
        if (c.v < this.range.from) return this._finish(c.t, 'dropped below start');
        if (c.t - this.t0 > MAX_RUN_MS) return this._finish(c.t, 'time limit');
    }

    /** Segment times between consecutive points: [{ from, to, s }] (s undefined until reached). */
    segments() {
        const pts = this.points(), out = [];
        for (let i = 1; i < pts.length; i++) {
            const a = this.cross[pts[i - 1]], b = this.cross[pts[i]];
            out.push({ from: pts[i - 1], to: pts[i], s: a !== undefined && b !== undefined ? b - a : undefined });
        }
        return out;
    }

    _finish(t, reason) {
        const ok = !reason;
        this.state = 'wait';
        this.endAt = ok ? this.cross[this.range.to] : Math.min(MAX_RUN_MS, t - this.t0) / 1000;
        if (ok) {
            this.total = this.cross[this.range.to];
            const dv = (this.range.to - this.range.from) / 3.6;
            this.last = {
                ok: true, at: Date.now(), total: this.total, segs: this.segments().map((s) => s.s),
                dist: this.distAtEnd, avgG: dv / this.total / 9.80665,
            };
            this.onDone(this.last);
        } else {
            this.last = { ok: false, reason, vmax: this.vmax, at: Date.now() };
        }
    }
}

module.exports = { RollTimer, ARM_MARGIN, LIFT_KMH };
