import { useEffect, useState } from "react";
import { fetchFaults, setWorkerFault } from "../api";
import type { WorkerFault } from "../types";

const WORKERS = ["worker-a", "worker-b"];

export function FaultPanel() {
  const [faults, setFaults] = useState<WorkerFault[]>([]);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function load() {
    try {
      setFaults(await fetchFaults());
      setError("");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load fault switches.");
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function apply(workerId: string, mode: "normal" | "fail" | "delay") {
    setMessage("");
    setError("");
    try {
      await setWorkerFault(workerId, mode, mode === "delay" ? 8 : 0);
      await load();
      setMessage(mode === "normal" ? `${workerId} is back to normal.` : `${workerId} is set to ${mode}.`);
    } catch (applyError) {
      setError(applyError instanceof Error ? applyError.message : "Could not set the fault switch.");
    }
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <h2 className="text-lg font-semibold text-slate-900">Failure simulation</h2>
      <p className="mt-1 text-sm text-slate-500">
        Development only, with no authentication. Normal is the reset. Delay uses 8 seconds, which is longer than the 5
        second worker timeout. Stop a container with Docker to make that worker unavailable.
      </p>
      {error && <p className="mt-3 text-sm text-rose-700">{error}</p>}
      {message && <p className="mt-3 text-sm text-slate-700">{message}</p>}
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        {WORKERS.map((workerId) => {
          const current = faults.find((fault) => fault.worker_id === workerId);
          return (
            <div key={workerId} className="rounded-lg bg-slate-50 p-3">
              <p className="text-sm font-semibold text-slate-900">{workerId}</p>
              <p className="mt-1 text-xs text-slate-500">Current: {current?.mode ?? "normal"}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button type="button" className={buttonClass} onClick={() => void apply(workerId, "normal")}>
                  Normal
                </button>
                <button type="button" className={buttonClass} onClick={() => void apply(workerId, "fail")}>
                  Fail
                </button>
                <button type="button" className={buttonClass} onClick={() => void apply(workerId, "delay")}>
                  Delay
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

const buttonClass =
  "rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100";
