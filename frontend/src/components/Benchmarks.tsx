import { useEffect, useState } from "react";
import { fetchBenchmarkManifest, loadBenchmarkRun } from "../api";
import type { BenchmarkRunFile } from "../types";
import { Card, Empty, ErrorText } from "./ui";

const PUBLISHED_RUNS = ["20261020T122342-d915d423.json", "20261020T122438-2abd398d.json"];

function ms(value: number | null | undefined): string {
  if (value == null) {
    return "—";
  }
  return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${Math.round(value)}ms`;
}

export function Benchmarks() {
  const [runs, setRuns] = useState<BenchmarkRunFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    void (async () => {
      try {
        const listed = await fetchBenchmarkManifest();
        const files = listed.length ? listed : PUBLISHED_RUNS;
        const loaded = await Promise.allSettled(files.map((file) => loadBenchmarkRun(file)));
        setRuns(
          loaded
            .filter((item): item is PromiseFulfilledResult<BenchmarkRunFile> => item.status === "fulfilled")
            .map((item) => item.value)
            .sort((a, b) => a.summary.started_at.localeCompare(b.summary.started_at)),
        );
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : "Could not load benchmark results.");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const maxRate = Math.max(0.0001, ...runs.map((run) => run.summary.throughput_completed_rps ?? 0));

  return (
    <div className="space-y-5">
      <Card
        title="Recorded load tests"
        subtitle="Many simulated payments sent at once against the running system. These are saved results, not live numbers."
      >
        {loading && <p className="text-sm text-slate-500">Loading…</p>}
        {error && <ErrorText>{error}</ErrorText>}
        {!loading && !error && runs.length === 0 && <Empty>No benchmark results are published in frontend/public/benchmarks.</Empty>}
        {runs.length > 0 && (
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="text-xs text-slate-500">
                <tr className="border-b border-slate-100">
                  <th className="py-2 pr-4 font-medium">Run</th>
                  <th className="py-2 pr-4 font-medium">Workers</th>
                  <th className="py-2 pr-4 font-medium">Payments</th>
                  <th className="py-2 pr-4 font-medium">Sent at once</th>
                  <th className="py-2 pr-4 font-medium">Payments / second</th>
                  <th className="py-2 pr-4 font-medium">Typical wait</th>
                  <th className="py-2 pr-4 font-medium">Slowest 5%</th>
                  <th className="py-2 font-medium">Outcomes</th>
                </tr>
              </thead>
              <tbody>
                {runs.map(({ summary }) => {
                  const rate = summary.throughput_completed_rps ?? 0;
                  return (
                    <tr key={summary.run_id} className="border-b border-slate-50 last:border-0">
                      <td className="py-3 pr-4 font-medium text-slate-900">{summary.run_label ?? summary.run_id}</td>
                      <td className="py-3 pr-4 tabular-nums">{summary.worker_count_configured}</td>
                      <td className="py-3 pr-4 tabular-nums">{summary.submitted ?? summary.workload_size}</td>
                      <td className="py-3 pr-4 tabular-nums">{summary.concurrency}</td>
                      <td className="py-3 pr-4">
                        <div className="flex items-center gap-2">
                          <div className="h-2 w-24 rounded-full bg-slate-100">
                            <div className="h-2 rounded-full bg-indigo-500" style={{ width: `${(rate / maxRate) * 100}%` }} />
                          </div>
                          <span className="tabular-nums">{rate.toFixed(2)}</span>
                        </div>
                      </td>
                      <td className="py-3 pr-4 tabular-nums">{ms(summary.api_latency_ms.p50)}</td>
                      <td className="py-3 pr-4 tabular-nums">{ms(summary.api_latency_ms.p95)}</td>
                      <td className="py-3">
                        <div className="flex flex-wrap gap-1">
                          {Object.entries(summary.payment_status_counts).map(([status, count]) => (
                            <span
                              key={status}
                              className={`rounded-md px-1.5 py-0.5 text-xs font-medium ${
                                status === "SUCCESS"
                                  ? "bg-emerald-100 text-emerald-800"
                                  : status === "UNKNOWN"
                                    ? "bg-violet-100 text-violet-800"
                                    : "bg-rose-100 text-rose-800"
                              }`}
                            >
                              {count} {status.toLowerCase()}
                            </span>
                          ))}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="How to read this">
        <ul className="list-disc space-y-1.5 pl-5 text-sm text-slate-600">
          <li>“Sent at once” is how many payments were in flight at the same time.</li>
          <li>“Typical wait” is the median time for the API to answer; “slowest 5%” is the 95th percentile.</li>
          <li>
            “Unknown” means the worker did not answer within the coordinator’s 5-second deadline under that load. Those payments were not
            counted as failures, and reconciliation can settle them later.
          </li>
          <li>
            Each run is recorded on one laptop with Docker, so absolute numbers depend on the machine. Compare runs with each other, not with
            real payment systems.
          </li>
        </ul>
      </Card>
    </div>
  );
}
