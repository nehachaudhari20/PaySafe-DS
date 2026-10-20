export type PaymentStatus = "PENDING" | "PROCESSING" | "SUCCESS" | "FAILED" | "UNKNOWN";

export type Payment = {
  id: number;
  transaction_id: string;
  amount: string;
  description: string;
  status: PaymentStatus | string;
  worker_id: string | null;
  idempotency_key: string | null;
  reconciliation_required: boolean;
  attempt_count: number;
  last_error: string | null;
  last_attempt_at: string | null;
  created_at: string;
  updated_at: string;
};

export type WorkerFault = {
  worker_id: string;
  mode: string;
  delay_seconds: number;
};

export type WorkerHealth = {
  worker_id: string;
  reachable: boolean;
  status: string;
};

export type PaymentEvent = {
  id: number;
  transaction_id: string;
  event_type: string;
  created_at: string;
  service: string;
  worker_id: string | null;
  attempt: number | null;
  lamport_time: number | null;
  message: string;
  metadata: Record<string, string | number | boolean> | null;
};

export type PaymentMetrics = {
  total_payments: number;
  successful_payments: number;
  failed_payments: number;
  unknown_payments: number;
  processing_payments: number;
  pending_payments: number;
  success_rate: number | null;
  success_rate_basis: string;
  worker_attempts: number;
  retries: number;
  reconciliation_resolved: number;
  reconciliation_inconclusive: number;
  fault_injection_enabled: boolean;
};

export type WorkersHealthResponse = {
  coordinator_reachable: boolean;
  workers: WorkerHealth[];
  leader_url?: string;
  detail?: string;
};

export type CoordinatorLeadership = {
  leader_id: number | null;
  term: number | null;
  lease_expires_at: string | null;
  leader_url: string;
  peers_configured: boolean;
};

export type ElectionEvent = {
  id: number;
  coordinator_id: number;
  event_type: string;
  message: string;
  term: number | null;
  peer_id: number | null;
  created_at: string;
};

export type ReconcileResult = {
  marked: number;
  transaction_ids: string[];
  resolved: string[];
  unknown: string[];
};

export type BenchmarkSummary = {
  run_id: string;
  run_label?: string;
  workload_size: number;
  worker_count_configured: number;
  concurrency: number;
  started_at: string;
  duration_seconds?: number;
  submitted?: number;
  http_2xx?: number;
  http_errors?: number;
  throughput_completed_rps: number | null;
  api_latency_ms: { p50: number | null; p95: number | null; p99?: number | null };
  payment_status_counts: Record<string, number>;
};

export type BenchmarkRunFile = {
  summary: BenchmarkSummary;
  validation?: {
    db?: {
      payment_rows_for_prefix: number;
      distinct_idempotency_keys: number;
      duplicate_idempotency_keys: string[];
      worker_effect_rows: number;
      duplicate_effect_transaction_ids: string[];
    };
    worker_distribution?: Record<string, number>;
  };
};
