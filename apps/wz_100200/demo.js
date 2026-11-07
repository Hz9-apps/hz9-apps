'use strict';
/**
 * Synthetic rolling pull for demo mode, fitted to the chosen test: cruise 20 km/h under its start,
 * pull to 10 km/h past its end (100-200 ~9 s), slow down, repeat.
 */
class Demo {
    constructor() { this.t0 = Date.now(); }
    speed(now, range) {
        const from = range ? range.from : 100, to = range ? range.to : 200;
        const v0 = from - 20, top = to + 10, vmax = top + 52, tau = 9.4 * vmax / 262;
        const pullEnd = -tau * Math.log((vmax - top) / (vmax - v0));
        const slow = 8, cycle = 4 + pullEnd + slow;
        const t = ((now - this.t0) / 1000) % cycle;
        if (t < 4) return v0;
        if (t < 4 + pullEnd) return vmax - (vmax - v0) * Math.exp(-(t - 4) / tau);
        return top - (top - v0) * Math.min(1, (t - 4 - pullEnd) / slow);
    }
}
module.exports = Demo;
