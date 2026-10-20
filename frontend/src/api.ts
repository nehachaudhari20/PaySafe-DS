import type { Payment, PaymentEvent, PaymentMetrics, WorkerFault, WorkersHealthResponse } from "./types";

export class ApiError extends Error {
  payment?: Payment;

  constructor(message: string, payment?: Payment) {
    super(message);
    this.name = "ApiError";
    this.payment = payment;
  }
}

type ErrorBody = {
  detail?: unknown;
};

export async function createPayment(amount: string, description: string, idempotencyKey: string): Promise<Payment> {
  return request<Payment>("/api/payments", {
    method: "POST",
    body: JSON.stringify({ amount, description }),
    headers: { "Idempotency-Key": idempotencyKey },
  });
}

export function fetchPayments(): Promise<Payment[]> {
  return request<Payment[]>("/api/payments");
}

export function fetchMetrics(): Promise<PaymentMetrics> {
  return request<PaymentMetrics>("/api/metrics");
}

export function fetchPaymentEvents(transactionId: string): Promise<PaymentEvent[]> {
  return request<PaymentEvent[]>(`/api/payments/${encodeURIComponent(transactionId)}/events`);
}

export function fetchWorkerHealth(): Promise<WorkersHealthResponse> {
  return request<WorkersHealthResponse>("/api/workers/health");
}

export function fetchCoordinatorLeadership(): Promise<CoordinatorLeadership> {
  return request<CoordinatorLeadership>("/api/coordinator/leadership");
}

export async function fetchBenchmarkManifest(): Promise<BenchmarkManifestEntry[]> {
  const response = await fetch("/benchmarks/manifest.json", { headers: { Accept: "application/json" } });
  if (!response.ok) {
    return [];
  }
  return (await response.json()) as BenchmarkManifestEntry[];
}

export async function loadBenchmarkRun(fileName: string): Promise<BenchmarkRunFile> {
  const response = await fetch(`/benchmarks/${encodeURIComponent(fileName)}`, { headers: { Accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`Benchmark file ${fileName} not found.`);
  }
  return (await response.json()) as BenchmarkRunFile;
}

export function fetchFaults(): Promise<WorkerFault[]> {
  return request<{ faults: WorkerFault[] }>("/api/admin/faults").then((body) => body.faults);
}

export function setWorkerFault(workerId: string, mode: "normal" | "fail" | "delay", delaySeconds = 0): Promise<WorkerFault> {
  return request<WorkerFault>("/api/admin/faults", {
    method: "POST",
    body: JSON.stringify({ worker_id: workerId, mode, delay_seconds: delaySeconds }),
  });
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...options,
      headers: {
        Accept: "application/json",
        ...(options?.body ? { "Content-Type": "application/json" } : {}),
        ...options?.headers,
      },
    });
  } catch {
    throw new ApiError("Could not reach the payment API.");
  }

  if (!response.ok) {
        if (item && typeof item === "object" && "msg" in item) {
  }
  return (await response.json()) as T;
}

async function toApiError(response: Response): Promise<ApiError> {
  let body: ErrorBody | null = null;
  try {
    body = (await response.json()) as ErrorBody;
  } catch {
    return new ApiError(`Request failed (${response.status}).`);
  }

  const detail = body?.detail;
  if (typeof detail === "string") {
    return new ApiError(detail);
  }
  if (Array.isArray(detail)) {
    const message = detail
      .map((item) => {
        if (item && typeof item === "object" && "msg" in item) {
          return String(item.msg);
        }
        return String(item);
      })
      .join("; ");
    return new ApiError(message || `Request failed (${response.status}).`);
  }
  if (detail && typeof detail === "object" && "message" in detail) {
    const record = detail as { message?: unknown; payment?: Payment };
    const message = typeof record.message === "string" ? record.message : `Request failed (${response.status}).`;
    return new ApiError(message, record.payment);
  }
  return new ApiError(`Request failed (${response.status}).`);
}
