'use strict';
/** Synthetic rolling pull for demo mode: cruise at 80, pull to ~210 km/h (100-200 ~9 s), slow down, repeat (24 s). */
class Demo {
    constructor() { this.t0 = Date.now(); }
    speed(now) {
        const t = ((now - this.t0) / 1000) % 24;
        const vmax = 262, v0 = 80, tau = 9.4;
        const pullEnd = -tau * Math.log((vmax - 210) / (vmax - v0));   // ~11.8 s to 210
        if (t < 4) return v0;
        if (t < 4 + pullEnd) return vmax - (vmax - v0) * Math.exp(-(t - 4) / tau);
        const t2 = t - 4 - pullEnd, slow = 24 - 4 - pullEnd;
        return 210 - (210 - v0) * Math.min(1, t2 / slow);
    }
}
module.exports = Demo;
