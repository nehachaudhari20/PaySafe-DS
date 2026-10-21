import type {
  BenchmarkRunFile,
  CoordinatorLeadership,
  ElectionEvent,
  Payment,
  PaymentEvent,
  PaymentMetrics,
  ReconcileResult,
  WorkerFault,
  WorkersHealthResponse,
} from "./types";

export class ApiError extends Error {
  payment?: Payment;
  status?: number;

  constructor(message: string, payment?: Payment, status?: number) {
    super(message);
    this.name = "ApiError";
    this.payment = payment;
    this.status = status;
  }
}

type ErrorBody = {
  detail?: unknown;
};

export type PaymentCreateMeta = {
  payment: Payment;
  idempotencyOutcome: "created" | "replayed" | "conflict" | null;
};

function readIdempotencyOutcome(response: Response): PaymentCreateMeta["idempotencyOutcome"] {
  const value = response.headers.get("X-PaySafe-Idempotency");
  if (value === "created" || value === "replayed" || value === "conflict") {
    return value;
  }
  return null;
}

export async function createPaymentWithMeta(
  amount: string,
  description: string,
  idempotencyKey: string,
): Promise<PaymentCreateMeta> {
  let response: Response;
  try {
    response = await fetch("/api/payments", {
      method: "POST",
      body: JSON.stringify({ amount, description }),
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
    });
  } catch {
    throw new ApiError("Could not reach the payment API.");
  }

  const idempotencyOutcome = readIdempotencyOutcome(response);
  if (!response.ok) {
    throw await toApiError(response);
  }
  const payment = (await response.json()) as Payment;
  return { payment, idempotencyOutcome };
}

export function createPayment(amount: string, description: string, idempotencyKey: string): Promise<Payment> {
  return createPaymentWithMeta(amount, description, idempotencyKey).then((result) => result.payment);
}

export function fetchPayments(): Promise<Payment[]> {
  return request<Payment[]>("/api/payments");
}

export function fetchPayment(transactionId: string): Promise<Payment> {
  return request<Payment>(`/api/payments/${encodeURIComponent(transactionId)}`);
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

export function fetchElectionEvents(limit = 30): Promise<ElectionEvent[]> {
  return request<ElectionEvent[]>(`/api/coordinator/election-events?limit=${limit}`);
}

export function crashLeader(seconds: number): Promise<{ crashed_leader_id: number; term: number; seconds: number }> {
  return request("/api/admin/leader/crash", { method: "POST", body: JSON.stringify({ seconds }) });
}

export function reconcile(): Promise<ReconcileResult> {
  return request<ReconcileResult>("/api/admin/reconcile", { method: "POST" });
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

export async function fetchBenchmarkManifest(): Promise<string[]> {
  const response = await fetch("/benchmarks/manifest.json", { headers: { Accept: "application/json" } });
  if (!response.ok) {
    return [];
  }
  try {
    const body = (await response.json()) as unknown;
    return Array.isArray(body) ? body.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export async function loadBenchmarkRun(fileName: string): Promise<BenchmarkRunFile> {
  const response = await fetch(`/benchmarks/${encodeURIComponent(fileName)}`, { headers: { Accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`Benchmark file ${fileName} was not found.`);
  }
  return (await response.json()) as BenchmarkRunFile;
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
    throw await toApiError(response);
  }
  return (await response.json()) as T;
}

async function toApiError(response: Response): Promise<ApiError> {
  let body: ErrorBody | null = null;
  try {
    body = (await response.json()) as ErrorBody;
  } catch {
    return new ApiError(`Request failed (${response.status}).`, undefined, response.status);
  }

  readIdempotencyOutcome(response);

  const detail = body?.detail;
  if (typeof detail === "string") {
    return new ApiError(detail, undefined, response.status);
  }
  if (Array.isArray(detail)) {
    const message = detail
      .map((item) => (item && typeof item === "object" && "msg" in item ? String(item.msg) : String(item)))
      .join("; ");
    return new ApiError(message || `Request failed (${response.status}).`, undefined, response.status);
  }
  if (detail && typeof detail === "object" && "message" in detail) {
    const record = detail as { message?: unknown; payment?: Payment };
    const message = typeof record.message === "string" ? record.message : `Request failed (${response.status}).`;
    return new ApiError(message, record.payment, response.status);
  }
  return new ApiError(`Request failed (${response.status}).`, undefined, response.status);
}
