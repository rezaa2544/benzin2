import { statfs } from 'node:fs/promises';
import os from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { NodeResources } from '../ports.js';

/**
 * Host metrics for the node monitor (task G-28).
 *
 * Node has no portable "current CPU %": what exists is cumulative ticks per core, so the honest
 * reading is the delta between two samples. `createHostTelemetry()` keeps the previous sample and
 * returns the utilisation since the last call — which is exactly what a heartbeat wants, because
 * the heartbeat interval *is* the sampling window.
 *
 * Everything is wrapped in try/catch: a monitoring field must never be able to fail a sweep or a
 * request, so a faulting `statfs` degrades to zero instead of throwing into the caller.
 */

const round = (value: number, digits = 1): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

type CpuTimes = { idle: number; total: number };

const sampleCpuTimes = (): CpuTimes => {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    const { user, nice, sys, irq, idle: cpuIdle } = cpu.times;
    idle += cpuIdle;
    total += user + nice + sys + irq + cpuIdle;
  }
  return { idle, total };
};

export interface HostTelemetry {
  /** Utilisation since the previous call (0 on the very first call). */
  resources(): Promise<NodeResources>;
}

export function createHostTelemetry(): HostTelemetry {
  let previous = sampleCpuTimes();
  // Mean event-loop delay in milliseconds: the number that separates "busy" from "blocked".
  const lag = monitorEventLoopDelay({ resolution: 20 });
  lag.enable();

  return {
    async resources(): Promise<NodeResources> {
      const current = sampleCpuTimes();
      const totalDelta = current.total - previous.total;
      const idleDelta = current.idle - previous.idle;
      const cpuPct = totalDelta > 0 ? (1 - idleDelta / totalDelta) * 100 : 0;
      previous = current;

      const totalMem = os.totalmem();
      const freeMem = os.freemem();

      let diskTotalGb = 0;
      let diskFreeGb = 0;
      try {
        const stats = await statfs(process.cwd());
        diskTotalGb = (stats.bsize * stats.blocks) / 1024 ** 3;
        diskFreeGb = (stats.bsize * stats.bavail) / 1024 ** 3;
      } catch {
        // Windows/POSIX differences, a missing mount — the panel shows zero instead of crashing.
      }

      const lagMs = Number.isFinite(lag.mean) ? lag.mean / 1e6 : null;
      lag.reset();

      return {
        cpuPct: round(Math.max(0, Math.min(100, cpuPct))),
        cores: os.cpus().length,
        memUsedPct: totalMem > 0 ? round(((totalMem - freeMem) / totalMem) * 100) : 0,
        memRssMb: round(process.memoryUsage().rss / 1024 ** 2),
        diskFreeGb: round(diskFreeGb, 2),
        diskTotalGb: round(diskTotalGb, 2),
        loadAvg: round(os.loadavg()[0] ?? 0, 2),
        eventLoopLagMs: lagMs === null ? null : round(lagMs, 2),
      };
    },
  };
}
