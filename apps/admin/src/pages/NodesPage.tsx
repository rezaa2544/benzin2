import { useEffect, useState } from 'react';
import type { ApiClient } from '../lib/api.js';
import { fmtNumber } from '../lib/format.js';
import {
  barWidth,
  describeJob,
  fmtGb,
  fmtPct,
  hasOnlyIdleSweeps,
  heartbeatAgeFa,
  jobKindFa,
  pctBarClass,
  recentJobs,
  stateTone,
} from '../lib/nodes.js';
import { useResource } from '../lib/useResource.js';
import type { NodeView, NodesOverview } from '../lib/types.js';
import { Notice } from '../components/ui.js';
import fa from '../i18n/fa.json';

/**
 * G-28 — live node screen.
 *
 * The owner runs his own PC as a helper server and wants to see, while it happens, how much of it
 * is being used and what it actually did. So this page polls rather than reloads: every node gets
 * a card with CPU, RAM and disk bars, the traffic it served in the last minute, and its work
 * report (the sweeps it ran, newest first). A helper shows «آماده‌به‌کار» until the primary's
 * heartbeat stops, and the banner at the top says which node is doing the work right now.
 */

const POLL_MS = 4_000;

function Meter({
  label,
  pct,
  hint,
}: {
  label: string;
  pct: number;
  hint: string;
}): JSX.Element {
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="text-xs text-muted">{label}</span>
        <span className="tnum text-xs font-bold">{fmtPct(pct)}</span>
      </div>
      <div className="mt-1 h-2 overflow-hidden rounded-full bg-surface" role="presentation">
        <div className={`h-full rounded-full ${pctBarClass(pct)}`} style={{ width: barWidth(pct) }} />
      </div>
      <p className="mt-1 text-[11px] text-muted">{hint}</p>
    </div>
  );
}

function NodeCard({ node }: { node: NodeView }): JSX.Element {
  const resources = node.resources;
  const diskUsedPct =
    resources && resources.diskTotalGb > 0
      ? ((resources.diskTotalGb - resources.diskFreeGb) / resources.diskTotalGb) * 100
      : 0;
  const jobs = recentJobs(node.jobs.recent);

  return (
    <article className="card space-y-4" data-testid={`node-${node.nodeId}`}>
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-bold">{node.name}</h2>
            {node.self ? (
              <span className="rounded-full bg-surface px-2 py-0.5 text-[11px] text-muted">
                {fa.nodes.selfBadge}
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-[11px] text-muted tnum">{node.nodeId}</p>
        </div>
        <div className="text-end">
          <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${stateTone(node.state)}`}>
            {node.stateFa}
          </span>
          <p className="mt-1 text-[11px] text-muted">
            {node.role === 'primary' ? fa.nodes.rolePrimary : fa.nodes.roleHelper} ·{' '}
            {heartbeatAgeFa(node.heartbeatAgeSeconds)}
          </p>
        </div>
      </header>

      <p className="rounded-lg bg-surface/60 px-2 py-1 text-xs">{node.dutiesFa}</p>

      {resources ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <Meter
            label={fa.nodes.cpu}
            pct={resources.cpuPct}
            hint={`${fmtNumber(resources.cores)} هسته · بار ${fmtNumber(Math.round(resources.loadAvg * 100) / 100)}`}
          />
          <Meter
            label={fa.nodes.memory}
            pct={resources.memUsedPct}
            hint={`${fmtNumber(Math.round(resources.memRssMb))} مگابایت در حال استفاده`}
          />
          <Meter
            label={fa.nodes.disk}
            pct={diskUsedPct}
            hint={`${fmtGb(resources.diskFreeGb)} آزاد از ${fmtGb(resources.diskTotalGb)}`}
          />
        </div>
      ) : (
        <Notice>{fa.nodes.noResources}</Notice>
      )}

      <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
        <div>
          <p className="text-muted">{fa.nodes.perMinute}</p>
          <p className="font-bold tnum">{fmtNumber(node.traffic.requestsPerMin)}</p>
        </div>
        <div>
          <p className="text-muted">{fa.nodes.latency}</p>
          <p className="font-bold tnum">{fmtNumber(Math.round(node.traffic.avgLatencyMs))} ms</p>
        </div>
        <div>
          <p className="text-muted">{fa.nodes.errors}</p>
          <p className="font-bold tnum">{fmtNumber(node.traffic.errors)}</p>
        </div>
        <div>
          <p className="text-muted">{fa.nodes.jobsTotal}</p>
          <p className="font-bold tnum">{fmtNumber(node.jobs.total)}</p>
        </div>
      </div>

      <div>
        <h3 className="mb-2 text-xs font-bold">{fa.nodes.workReport}</h3>
        {jobs.length === 0 ? (
          <p className="text-[11px] text-muted">
            {node.jobs.recent.length > 0 ? fa.nodes.idleSweeps : fa.nodes.noJobs}
          </p>
        ) : (
          <ul className="space-y-1">
            {jobs.map((job, index) => (
              <li key={`${job.at}-${index}`} className="flex flex-wrap justify-between gap-2 text-[11px]">
                <span>{describeJob(job)}</span>
                <span className="text-muted tnum">{job.at.slice(11, 16)}</span>
              </li>
            ))}
          </ul>
        )}
        {node.jobs.lastJobAt ? (
          <p className="mt-2 text-[11px] text-muted tnum">
            {fa.nodes.lastRun}: {node.jobs.lastJobAt.slice(11, 19)}
          </p>
        ) : null}
        {node.jobs.last30Min > 0 ? (
          <p className="mt-1 text-[11px] text-muted">
            {fa.nodes.last30} {fmtNumber(node.jobs.last30Min)}
          </p>
        ) : null}
      </div>

      <footer className="flex flex-wrap justify-between gap-2 border-t border-line pt-2 text-[11px] text-muted">
        <span>
          {fa.nodes.uptime}: {fhms(node.uptimeSeconds)}
        </span>
        <span>
          {fa.nodes.version}: {node.version ?? '—'}
        </span>
      </footer>
    </article>
  );
}

/** Compact «۲ روز ۳ ساعت ۵ دقیقه» — uptime, in Persian, without a wall of digits. */
const fhms = (seconds: number): string => {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const parts: string[] = [];
  if (days > 0) parts.push(`${fmtNumber(days)} روز`);
  if (hours > 0) parts.push(`${fmtNumber(hours)} ساعت`);
  if (parts.length === 0) parts.push(`${fmtNumber(minutes)} دقیقه`);
  return parts.join(' و ');
};

export function NodesPage({ api }: { api: ApiClient }): JSX.Element {
  const [tick, setTick] = useState(0);
  const overview = useResource<NodesOverview>(() => api.get<NodesOverview>('/v1/admin/nodes'), [tick]);

  // "Live" is the requirement, not an extra: poll while the tab is open, and stop when hidden so a
  // forgotten tab does not keep hammering the API.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') setTick((value) => value + 1);
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, []);

  if (overview.loading && !overview.data) return <Notice>{fa.app.loading}</Notice>;
  if (overview.error) return <Notice tone="error">{overview.error.message}</Notice>;
  const data = overview.data;
  if (!data) return <Notice>{fa.app.empty}</Notice>;

  const activeNode = data.nodes.find((node) => node.nodeId === data.activeNodeId) ?? null;

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-bold">{fa.nodes.title}</h1>
          <p className="text-xs text-muted">{fa.nodes.subtitle}</p>
        </div>
        <button
          type="button"
          className="btn px-2 py-1 text-xs"
          onClick={overview.reload}
          aria-label={fa.app.refresh}
        >
          {fa.app.refresh}
        </button>
      </div>

      <div className="card space-y-1 text-sm">
        <p>
          <span className="text-muted">{fa.nodes.activeNow}: </span>
          <span className="font-bold">
            {activeNode ? activeNode.name : fa.nodes.nobody}
          </span>
        </p>
        <p className="text-xs text-muted">{data.failover.reasonFa}</p>
        <p className="text-[11px] text-muted">
          {fa.nodes.staleWindow}: {fmtNumber(data.staleAfterSeconds)} {fa.nodes.seconds}
        </p>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        {data.nodes.map((node) => (
          <NodeCard key={node.nodeId} node={node} />
        ))}
      </div>

      {data.nodes.length > 0 && data.nodes.every((node) => hasOnlyIdleSweeps(node.jobs.recent)) ? (
        <Notice>{fa.nodes.workReportHint.replace('{kind}', jobKindFa('expiry-sweep'))}</Notice>
      ) : null}
    </section>
  );
}
