export type SaleStatus = "created" | "awaiting_payment" | "paid" | "cancelled";

export type SaleLineInput = {
  description: string;
  quantity: number;
  unit_price_minor: number;
};

export type SaleLine = SaleLineInput & {
  id: string;
  line_total_minor: number;
};

export type Sale = {
  id: string;
  tenant_id: string;
  attendant_id: string;
  status: SaleStatus;
  currency: "KES";
  total_minor: number;
  created_at: string;
  paid_at: string | null;
  payment_id: string | null;
  lines: SaleLine[];
};

export type Payment = {
  id: string;
  sale_id: string;
  status: "initiated" | "pending" | "confirmed" | "paid" | "failed" | "timed_out";
  msisdn: string;
  created_at: string;
  checkout_request_id?: string | null;
};

export type IdentitySettings = {
  tenantId: string;
  userId: string;
  role: "attendant" | "owner";
  simulate: boolean;
  simulatorAutoConfirm: boolean;
};

export type SystemHealth = {
  health: "ok" | "down" | "unknown";
  ready: "ok" | "down" | "unknown";
  version: {
    service: string;
    commit: string;
    digest: string;
    environment: string;
    started_at: string;
  } | null;
  checkedAt: string;
  simulated: boolean;
};

export class TillFlowError extends Error {
  friendlyMessage: string;
  status: number | undefined;

  constructor(friendlyMessage: string, status?: number) {
    super(friendlyMessage);
    this.name = "TillFlowError";
    this.friendlyMessage = friendlyMessage;
    this.status = status;
  }
}

type SaleRequest = {
  lines: SaleLineInput[];
  total_minor: number;
};

const simulatorSales = new Map<string, Sale>();
const simulatorSaleRequests = new Map<string, Sale>();
const simulatorPaymentRequests = new Map<string, Payment>();

export function isLovablePreviewHost() {
  if (typeof window === "undefined") return false;
  return window.location.hostname.toLowerCase().includes("lovable");
}

export function shouldSimulate(settings: Pick<IdentitySettings, "simulate">) {
  return isLovablePreviewHost() || settings.simulate;
}

export function newIdempotencyKey() {
  return crypto.randomUUID();
}

export async function createSale(
  settings: IdentitySettings,
  lines: SaleLineInput[],
  idempotencyKey: string,
) {
  const total_minor = lines.reduce((sum, line) => sum + line.quantity * line.unit_price_minor, 0);
  return request<Sale>(settings, "/sales", {
    method: "POST",
    idempotencyKey,
    body: { lines, total_minor },
  });
}

export async function getSale(settings: IdentitySettings, saleId: string) {
  return request<Sale>(settings, `/sales/${encodeURIComponent(saleId)}`, { method: "GET" });
}

export async function cancelSale(settings: IdentitySettings, saleId: string) {
  return request<Sale>(settings, `/sales/${encodeURIComponent(saleId)}/cancel`, { method: "POST" });
}

export async function paySale(settings: IdentitySettings, saleId: string, msisdn: string, idempotencyKey: string) {
  return request<Payment>(settings, `/sales/${encodeURIComponent(saleId)}/pay`, {
    method: "POST",
    idempotencyKey,
    body: { msisdn },
  });
}

export async function getSystemHealth(settings: Pick<IdentitySettings, "simulate">) {
  if (shouldSimulate(settings)) return simulatorHealth();

  const checkedAt = new Date().toISOString();
  const [health, ready, version] = await Promise.allSettled([
    fetchStatus("/health"),
    fetchStatus("/ready"),
    fetchVersion("/version"),
  ]);

  return {
    health: health.status === "fulfilled" ? health.value : "down",
    ready: ready.status === "fulfilled" ? ready.value : "down",
    version: version.status === "fulfilled" ? version.value : null,
    checkedAt,
    simulated: false,
  } satisfies SystemHealth;
}

async function request<T>(
  settings: IdentitySettings,
  path: string,
  options: {
    method: "GET" | "POST";
    idempotencyKey?: string;
    body?: unknown;
  },
): Promise<T> {
  assertAllowedPath(path);

  if (shouldSimulate(settings)) {
    return simulatorRequest<T>(settings, path, options);
  }

  const headers = new Headers();
  headers.set("X-Tenant-Id", settings.tenantId.trim());
  headers.set("X-User-Id", settings.userId.trim());
  headers.set("X-Role", settings.role);
  if (options.idempotencyKey) headers.set("Idempotency-Key", options.idempotencyKey);
  if (options.body !== undefined) headers.set("Content-Type", "application/json");

  let response: Response;
  try {
    const requestInit: RequestInit = {
      method: options.method,
      headers,
    };
    if (options.body !== undefined) requestInit.body = JSON.stringify(options.body);
    response = await fetch(path, requestInit);
  } catch {
    throw new TillFlowError("Can't reach TillFlow right now");
  }

  if (!response.ok) {
    throw await friendlyError(response);
  }

  return (await response.json()) as T;
}

function assertAllowedPath(path: string) {
  const blocked =
    path.startsWith("/internal") ||
    path.startsWith("/payments/callback") ||
    path.startsWith("/payments/b2c/callback") ||
    path.startsWith("/callbacks/");
  if (blocked) {
    throw new TillFlowError("Can't reach TillFlow right now");
  }
}

async function friendlyError(response: Response) {
  const contentType = response.headers.get("content-type") ?? "";
  const body = await response.clone().text().catch(() => "");
  if (response.status === 400) return new TillFlowError("Check the details", response.status);
  if (response.status === 401) {
    return new TillFlowError("Identity headers missing — open Settings", response.status);
  }
  if (response.status === 403) {
    if (contentType.includes("text/html") || body.toLowerCase().includes("blocked")) {
      return new TillFlowError("Too many requests — wait a minute", response.status);
    }
    return new TillFlowError("This role/attendant can't do that", response.status);
  }
  if (response.status === 429) return new TillFlowError("Too many requests — wait a minute", response.status);
  if (response.status === 404) return new TillFlowError("Sale not found", response.status);
  if (response.status === 409) return new TillFlowError("Already paid or cancelled", response.status);
  return new TillFlowError("Can't reach TillFlow right now", response.status);
}

async function fetchStatus(path: "/health" | "/ready") {
  assertAllowedPath(path);
  const response = await fetch(path);
  return response.ok ? "ok" : "down";
}

async function fetchVersion(path: "/version") {
  assertAllowedPath(path);
  const response = await fetch(path);
  if (!response.ok) throw new TillFlowError("Can't reach TillFlow right now", response.status);
  return (await response.json()) as NonNullable<SystemHealth["version"]>;
}

async function simulatorRequest<T>(
  settings: IdentitySettings,
  path: string,
  options: {
    method: "GET" | "POST";
    idempotencyKey?: string;
    body?: unknown;
  },
) {
  await quietDelay(280);

  if (path === "/sales" && options.method === "POST") {
    if (settings.role !== "attendant") throw new TillFlowError("This role/attendant can't do that", 403);
    if (!options.idempotencyKey) throw new TillFlowError("Check the details", 400);
    const replay = simulatorSaleRequests.get(options.idempotencyKey);
    if (replay) return replay as T;

    const payload = options.body as SaleRequest;
    const sale = makeSale(settings, payload.lines, payload.total_minor);
    simulatorSales.set(sale.id, sale);
    simulatorSaleRequests.set(options.idempotencyKey, sale);
    return sale as T;
  }

  const saleMatch = path.match(/^\/sales\/([^/]+)$/);
  if (saleMatch && options.method === "GET") {
    const sale = simulatorSales.get(decodeURIComponent(saleMatch[1] ?? ""));
    if (!sale) throw new TillFlowError("Sale not found", 404);
    return sale as T;
  }

  const cancelMatch = path.match(/^\/sales\/([^/]+)\/cancel$/);
  if (cancelMatch && options.method === "POST") {
    const sale = simulatorSales.get(decodeURIComponent(cancelMatch[1] ?? ""));
    if (!sale) throw new TillFlowError("Sale not found", 404);
    if (sale.status !== "created") throw new TillFlowError("Already paid or cancelled", 409);
    const cancelled = { ...sale, status: "cancelled" as const };
    simulatorSales.set(cancelled.id, cancelled);
    return cancelled as T;
  }

  const payMatch = path.match(/^\/sales\/([^/]+)\/pay$/);
  if (payMatch && options.method === "POST") {
    if (!options.idempotencyKey) throw new TillFlowError("Check the details", 400);
    const replay = simulatorPaymentRequests.get(options.idempotencyKey);
    if (replay) return replay as T;

    const saleId = decodeURIComponent(payMatch[1] ?? "");
    const sale = simulatorSales.get(saleId);
    if (!sale) throw new TillFlowError("Sale not found", 404);
    if (sale.status !== "created") throw new TillFlowError("Already paid or cancelled", 409);

    const payment: Payment = {
      id: crypto.randomUUID(),
      sale_id: sale.id,
      status: "pending",
      msisdn: (options.body as { msisdn: string }).msisdn,
      created_at: new Date().toISOString(),
    };
    const awaiting = { ...sale, status: "awaiting_payment" as const, payment_id: payment.id };
    simulatorSales.set(sale.id, awaiting);
    simulatorPaymentRequests.set(options.idempotencyKey, payment);

    if (settings.simulatorAutoConfirm === false) return payment as T;

    window.setTimeout(() => {
      const latest = simulatorSales.get(sale.id);
      if (latest?.status === "awaiting_payment") {
        simulatorSales.set(sale.id, {
          ...latest,
          status: "paid",
          paid_at: new Date().toISOString(),
          payment_id: payment.id,
        });
      }
    }, 6000);

    return payment as T;
  }

  throw new TillFlowError("Sale not found", 404);
}

function makeSale(settings: IdentitySettings, lines: SaleLineInput[], total_minor: number): Sale {
  return {
    id: crypto.randomUUID(),
    tenant_id: settings.tenantId,
    attendant_id: settings.userId,
    status: "created",
    currency: "KES",
    total_minor,
    created_at: new Date().toISOString(),
    paid_at: null,
    payment_id: null,
    lines: lines.map((line) => ({
      id: crypto.randomUUID(),
      ...line,
      line_total_minor: line.quantity * line.unit_price_minor,
    })),
  };
}

function simulatorHealth(): SystemHealth {
  return {
    health: "ok",
    ready: "ok",
    version: {
      service: "tillflow-api",
      commit: "preview",
      digest: "simulated",
      environment: "preview",
      started_at: new Date().toISOString(),
    },
    checkedAt: new Date().toISOString(),
    simulated: true,
  };
}

function quietDelay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
