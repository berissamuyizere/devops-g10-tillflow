import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelSale,
  createSale,
  getSale,
  getSystemHealth,
  isLovablePreviewHost,
  newIdempotencyKey,
  paySale,
  shouldSimulate,
  TillFlowError,
  type IdentitySettings,
  type Sale,
  type SaleLineInput,
  type SaleStatus,
  type SystemHealth,
} from "../lib/api";
import { DASHBOARD_URL, RUNBOOK_URL } from "../config";

export const Route = createFileRoute("/demo")({
  head: () => ({
    meta: [
      { title: "TillFlow Till — Mara House Demo" },
      { name: "description", content: "A working TillFlow till: create a sale, send an M-Pesa payment request and watch it confirm." },
      { property: "og:title", content: "TillFlow Till — Mara House Demo" },
      { property: "og:description", content: "Create a sale, send an M-Pesa payment request and watch it confirm." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: DemoPage,
});

const DEFAULT_SETTINGS: IdentitySettings = {
  tenantId: "11111111-1111-1111-1111-111111111111",
  userId: "22222222-2222-2222-2222-222222222222",
  role: "attendant",
  simulate: false,
  simulatorAutoConfirm: true,
};

const SETTINGS_KEY = "tillflow.settings";
const SESSION_SALES_KEY = "tillflow.sessionSales";
const POLL_LIMIT_MS = 90_000;
const POLL_INTERVAL_MS = 3_000;
const DEFAULT_PHONE = "254700000000";
const PHONE_RE = /^2547\d{8}$/;

const QUICK_ADD: { description: string; unit_price_minor: number }[] = [
  { description: "Grilled Sea Bass", unit_price_minor: 240_000 },
  { description: "Jollof Rice", unit_price_minor: 95_000 },
  { description: "Samosa", unit_price_minor: 35_000 },
  { description: "Sparkling Water", unit_price_minor: 30_000 },
];

type DraftLine = { description: string; unit_price_minor: number; quantity: number };
type SessionSale = { id: string; created_at: string; total_minor: number; status: SaleStatus };

const money = (minor: number) =>
  new Intl.NumberFormat("en-KE", { style: "currency", currency: "KES" }).format(minor / 100);

const emptyLine = (): DraftLine => ({ description: "", unit_price_minor: 0, quantity: 1 });

const statusLabel: Record<SaleStatus, string> = {
  created: "Created",
  awaiting_payment: "Pending",
  paid: "Paid",
  cancelled: "Cancelled",
};

const statusTone: Record<SaleStatus, string> = {
  created: "available",
  awaiting_payment: "pending",
  paid: "paid",
  cancelled: "occupied",
};

function StatusBadge({ status }: { status: SaleStatus }) {
  return (
    <span className={`status status--${statusTone[status]}`}>
      <i aria-hidden="true" />
      {statusLabel[status]}
    </span>
  );
}

function friendly(error: unknown) {
  return error instanceof TillFlowError ? error.friendlyMessage : "Can't reach TillFlow right now";
}

function DemoPage() {
  const [settings, setSettings] = useState<IdentitySettings>(DEFAULT_SETTINGS);
  const [sessionSales, setSessionSales] = useState<SessionSale[]>([]);
  const [hydrated, setHydrated] = useState(false);

  const [view, setView] = useState<"new" | "find">("new");
  const [step, setStep] = useState<"sale" | "payment" | "done">("sale");
  const [lines, setLines] = useState<DraftLine[]>([emptyLine()]);
  const [phone, setPhone] = useState(DEFAULT_PHONE);
  const [sale, setSale] = useState<Sale | null>(null);
  const [paymentId, setPaymentId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [paymentStatusText, setPaymentStatusText] = useState("");
  const [pollExpired, setPollExpired] = useState(false);

  const [findId, setFindId] = useState("");
  const [foundSale, setFoundSale] = useState<Sale | null>(null);

  const [health, setHealth] = useState<SystemHealth | null>(null);
  const [statusOpen, setStatusOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const saleKeyRef = useRef<string | null>(null);
  const payKeyRef = useRef<string | null>(null);

  const simulating = hydrated ? shouldSimulate(settings) : false;
  const previewLocked = hydrated ? isLovablePreviewHost() : false;

  // Load persisted state
  useEffect(() => {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) setSettings({ ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<IdentitySettings>) });
    } catch { /* ignore */ }
    try {
      const raw = localStorage.getItem(SESSION_SALES_KEY);
      if (raw) setSessionSales(JSON.parse(raw) as SessionSale[]);
    } catch { /* ignore */ }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* ignore */ }
  }, [settings, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    try { localStorage.setItem(SESSION_SALES_KEY, JSON.stringify(sessionSales)); } catch { /* ignore */ }
  }, [sessionSales, hydrated]);

  // System health
  useEffect(() => {
    if (!hydrated) return;
    let alive = true;
    const check = async () => {
      try {
        const result = await getSystemHealth(settings);
        if (alive) setHealth(result);
      } catch {
        if (alive) setHealth(null);
      }
    };
    void check();
    const id = window.setInterval(check, 60_000);
    return () => { alive = false; window.clearInterval(id); };
  }, [hydrated, settings]);

  const remember = useCallback((s: Sale) => {
    setSessionSales((prev) => {
      const entry: SessionSale = { id: s.id, created_at: s.created_at, total_minor: s.total_minor, status: s.status };
      return [entry, ...prev.filter((x) => x.id !== s.id)].slice(0, 12);
    });
  }, []);

  const totalMinor = lines.reduce((sum, l) => sum + l.quantity * l.unit_price_minor, 0);
  const validLines = lines.filter((l) => l.description.trim() && l.unit_price_minor > 0 && l.quantity > 0);
  const canCreate = validLines.length > 0 && totalMinor > 0 && !busy;
  const phoneValid = PHONE_RE.test(phone);

  // Polling
  useEffect(() => {
    if (step !== "payment" || sale?.status !== "awaiting_payment" || pollExpired) return;
    let alive = true;
    const startedAt = Date.now();
    const id = window.setInterval(async () => {
      if (Date.now() - startedAt > POLL_LIMIT_MS) {
        window.clearInterval(id);
        if (!alive) return;
        setPollExpired(true);
        setMessage("Still pending — a timeout is not a failure. It will settle once the confirmation arrives.");
        return;
      }
      try {
        const latest = await getSale(settings, sale.id);
        if (!alive) return;
        setSale(latest);
        remember(latest);
        if (latest.status === "paid") {
          setStep("done");
          setPaymentStatusText("Payment received.");
        }
      } catch { /* keep polling */ }
    }, POLL_INTERVAL_MS);
    return () => { alive = false; window.clearInterval(id); };
  }, [step, sale, settings, pollExpired, remember]);

  const updateLine = (index: number, patch: Partial<DraftLine>) =>
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));

  const quickAdd = (item: { description: string; unit_price_minor: number }) => {
    setLines((prev) => {
      const existing = prev.findIndex((l) => l.description.trim().toLowerCase() === item.description.toLowerCase());
      if (existing >= 0) {
        return prev.map((l, i) => (i === existing ? { ...l, quantity: l.quantity + 1 } : l));
      }
      const blank = prev.findIndex((l) => !l.description.trim() && l.unit_price_minor === 0);
      if (blank >= 0) {
        return prev.map((l, i) => (i === blank ? { ...item, quantity: 1 } : l));
      }
      return [...prev, { ...item, quantity: 1 }];
    });
  };

  const handleCreate = async () => {
    setMessage(null);
    setBusy(true);
    if (!saleKeyRef.current) saleKeyRef.current = newIdempotencyKey();
    try {
      const payload: SaleLineInput[] = validLines.map((l) => ({
        description: l.description.trim(),
        quantity: l.quantity,
        unit_price_minor: l.unit_price_minor,
      }));
      const created = await createSale(settings, payload, saleKeyRef.current);
      saleKeyRef.current = null;
      setSale(created);
      remember(created);
      setStep("payment");
    } catch (error) {
      setMessage(friendly(error));
    } finally {
      setBusy(false);
    }
  };

  const handleCancel = async () => {
    if (!sale) return;
    setMessage(null);
    setBusy(true);
    try {
      const cancelled = await cancelSale(settings, sale.id);
      setSale(cancelled);
      remember(cancelled);
      setPaymentStatusText("Sale cancelled.");
    } catch (error) {
      setMessage(friendly(error));
    } finally {
      setBusy(false);
    }
  };

  const handlePay = async () => {
    if (!sale || !phoneValid) return;
    setMessage(null);
    setBusy(true);
    setPollExpired(false);
    if (!payKeyRef.current) payKeyRef.current = newIdempotencyKey();
    try {
      const payment = await paySale(settings, sale.id, phone, payKeyRef.current);
      payKeyRef.current = null;
      setPaymentId(payment.id);
      setPaymentStatusText("Payment request sent. Waiting for the customer to approve.");
      const latest = await getSale(settings, sale.id);
      setSale(latest);
      remember(latest);
      if (latest.status === "paid") setStep("done");
    } catch (error) {
      setMessage(friendly(error));
    } finally {
      setBusy(false);
    }
  };

  const checkAgain = async () => {
    if (!sale) return;
    setBusy(true);
    try {
      const latest = await getSale(settings, sale.id);
      setSale(latest);
      remember(latest);
      if (latest.status === "paid") {
        setStep("done");
        setMessage(null);
        setPaymentStatusText("Payment received.");
      }
    } catch (error) {
      setMessage(friendly(error));
    } finally {
      setBusy(false);
    }
  };

  const startNewSale = () => {
    setLines([emptyLine()]);
    setPhone(DEFAULT_PHONE);
    setSale(null);
    setPaymentId(null);
    setMessage(null);
    setPaymentStatusText("");
    setPollExpired(false);
    saleKeyRef.current = null;
    payKeyRef.current = null;
    setStep("sale");
    setView("new");
  };

  const handleFind = async (id?: string) => {
    const target = (id ?? findId).trim();
    if (!target) return;
    setMessage(null);
    setBusy(true);
    try {
      const result = await getSale(settings, target);
      setFoundSale(result);
      remember(result);
    } catch (error) {
      setFoundSale(null);
      setMessage(friendly(error));
    } finally {
      setBusy(false);
    }
  };

  const dotState = !health ? "unknown" : health.health === "ok" && health.ready === "ok" ? "ok" : health.health === "down" || health.ready === "down" ? "down" : "unknown";
  const pending = message?.startsWith("Still pending") ?? false;

  const dotTone = dotState === "ok" ? "paid" : dotState === "down" ? "occupied" : "pending";

  return (
    <div className="demo-page">
      <header className="demo-bar">
        <Link to="/" className="brand">
          <b>MARA HOUSE</b>
          <span>Powered by TillFlow</span>
        </Link>
        <span className="badge">Till</span>
        <div className="demo-bar-actions">
          {simulating && <span className="badge">Preview · simulated</span>}
          <button type="button" className="button button--outline" aria-expanded={statusOpen} onClick={() => setStatusOpen((v) => !v)}>
            <span className={`status status--${dotTone}`}><i aria-hidden="true" />System status</span>
          </button>
          {statusOpen && (
            <div className="payment-panel demo-popover" role="dialog" aria-label="System status">
              <div className="demo-kv"><span>Health</span><b>{health?.health ?? "unknown"}</b></div>
              <div className="demo-kv"><span>Ready</span><b>{health?.ready ?? "unknown"}</b></div>
              <div className="demo-kv"><span>Commit</span><b>{health?.version?.commit.slice(0, 7) ?? "—"}</b></div>
              <div className="demo-kv"><span>Environment</span><b>{health?.version?.environment ?? "—"}</b></div>
              <div className="demo-links">
                <a href={DASHBOARD_URL} target="_blank" rel="noreferrer">Dashboards</a>
                <a href={RUNBOOK_URL}>Runbook</a>
              </div>
              <p className="demo-note">In simulator mode the oldest-pending alert can stay in ALARM; that is expected.</p>
            </div>
          )}
          <button type="button" className="button button--outline" onClick={() => setSettingsOpen(true)}>Settings</button>
        </div>
      </header>

      <main className="demo-main">
        <div className="demo-tabs" role="tablist" aria-label="Till views">
          <button type="button" role="tab" aria-selected={view === "new"} className={view === "new" ? "is-active" : ""} onClick={() => setView("new")}>New sale</button>
          <button type="button" role="tab" aria-selected={view === "find"} className={view === "find" ? "is-active" : ""} onClick={() => setView("find")}>Find a sale</button>
        </div>

        {view === "new" && (
          <>
            <ol className="demo-steps">
              {(["sale", "payment", "done"] as const).map((s, i) => (
                <li key={s} aria-current={step === s ? "step" : undefined} className={step === s ? "is-active" : ""}>
                  <i>{i + 1}</i>
                  <span>{s === "sale" ? "Sale" : s === "payment" ? "Payment" : "Done"}</span>
                </li>
              ))}
            </ol>

            {step === "sale" && (
              <section className="payment-panel demo-panel">
                <h1 className="demo-heading">New sale</h1>
                <div className="demo-quick">
                  {QUICK_ADD.map((item) => (
                    <button type="button" key={item.description} onClick={() => quickAdd(item)}>
                      {item.description} <b>{money(item.unit_price_minor)}</b>
                    </button>
                  ))}
                </div>
                <div className="demo-lines">
                  {lines.map((line, index) => (
                    <div className="demo-row" key={index}>
                      <label className="demo-field demo-field--grow">
                        <span>Item</span>
                        <input value={line.description} placeholder="Description" onChange={(e) => updateLine(index, { description: e.target.value })} />
                      </label>
                      <label className="demo-field">
                        <span>Price (KES)</span>
                        <input
                          inputMode="numeric"
                          value={line.unit_price_minor ? String(line.unit_price_minor / 100) : ""}
                          onChange={(e) => {
                            const digits = e.target.value.replace(/\D/g, "");
                            updateLine(index, { unit_price_minor: digits ? Number(digits) * 100 : 0 });
                          }}
                        />
                      </label>
                      <div className="demo-qty">
                        <button type="button" aria-label={`Decrease quantity for line ${index + 1}`} onClick={() => updateLine(index, { quantity: Math.max(1, line.quantity - 1) })}>−</button>
                        <b>{line.quantity}</b>
                        <button type="button" aria-label={`Increase quantity for line ${index + 1}`} onClick={() => updateLine(index, { quantity: line.quantity + 1 })}>+</button>
                      </div>
                      <span className="demo-line-total">{money(line.quantity * line.unit_price_minor)}</span>
                      {lines.length > 1 && (
                        <button type="button" className="demo-remove" aria-label={`Remove line ${index + 1}`} onClick={() => setLines((prev) => prev.filter((_, i) => i !== index))}>×</button>
                      )}
                    </div>
                  ))}
                </div>
                <div className="demo-actions">
                  <button type="button" className="button button--outline" onClick={() => setLines((prev) => [...prev, emptyLine()])}>Add item</button>
                </div>
                <div className="pos-total"><span>TOTAL</span><strong>{money(totalMinor)}</strong></div>
                <div className="demo-actions">
                  <button type="button" className="button button--green" disabled={!canCreate} onClick={handleCreate}>
                    {busy ? "Creating…" : "Create sale"}
                  </button>
                  {sale?.status === "created" && (
                    <button type="button" className="button button--outline" onClick={handleCancel}>Cancel sale</button>
                  )}
                </div>
              </section>
            )}

            {step === "payment" && sale && (
              <section className="payment-panel demo-panel">
                <div className="payment-head">
                  <div>
                    <small>Sale {sale.id.slice(0, 8)} · {sale.lines.length} item{sale.lines.length === 1 ? "" : "s"}</small>
                    <strong>{money(sale.total_minor)}</strong>
                  </div>
                  <StatusBadge status={sale.status} />
                </div>

                <div>
                  {sale.lines.map((l) => (
                    <div className="transaction-row" key={l.id}>
                      <span>{l.quantity} × {l.description}</span>
                      <strong>{money(l.line_total_minor)}</strong>
                    </div>
                  ))}
                </div>

                {sale.status === "created" && (
                  <>
                    <label className="demo-field">
                      <span>Customer phone</span>
                      <input
                        inputMode="numeric"
                        value={phone}
                        aria-invalid={!phoneValid}
                        onChange={(e) => setPhone(e.target.value.replace(/\D/g, "").slice(0, 12))}
                      />
                    </label>
                    <p className="demo-note">Use 2547XXXXXXXX.</p>
                    <div className="demo-actions">
                      <button type="button" className="button button--green" disabled={!phoneValid || busy} onClick={handlePay}>
                        {busy ? "Sending…" : "Send payment request"}
                      </button>
                      <button type="button" className="button button--outline" onClick={() => setStep("sale")}>Back to sale</button>
                      <button type="button" className="button button--outline" onClick={handleCancel}>Cancel sale</button>
                    </div>
                  </>
                )}

                {sale.status === "awaiting_payment" && (
                  <div className="confirmation-state">
                    <div className="confirmation-icon"><i aria-hidden="true" /></div>
                    <div>
                      <strong>Waiting for the customer to approve on their phone.</strong>
                      <span>{simulating ? "Preview only — no M-Pesa request was sent." : "The sale stays pending until the callback arrives. Silence is not a decline. Use 254700000000."}</span>
                    </div>
                  </div>
                )}

                {sale.status === "cancelled" && (
                  <div className="demo-actions"><button type="button" className="button button--outline" onClick={startNewSale}>Start a new sale</button></div>
                )}

                {pollExpired && (
                  <div className="demo-actions"><button type="button" className="button button--outline" disabled={busy} onClick={checkAgain}>Check again</button></div>
                )}

                <p className="demo-note" aria-live="polite">{paymentStatusText}</p>
              </section>
            )}

            {step === "done" && sale && (
              <section className="payment-panel demo-panel">
                <div className="demo-confirm">
                  <div className="confirmation-icon" aria-hidden="true">✓</div>
                  <div>
                    {simulating ? (
                      <>
                        <h1 className="demo-heading">Payment received (simulated)</h1>
                        <p className="demo-note">Preview only — no M-Pesa request was sent and no money moved.</p>
                      </>
                    ) : (
                      <>
                        <h1 className="demo-heading">Payment received</h1>
                        <p className="demo-note">Sale is paid. Live M-Pesa stays fake; this used the signed-callback path.</p>
                        {(sale.payment_id ?? paymentId) && (
                          <p className="demo-note">Payment ref {(sale.payment_id ?? paymentId ?? "").slice(0, 8)}</p>
                        )}
                      </>
                    )}
                  </div>
                </div>
                <div className="pos-total"><span>TOTAL</span><strong>{money(sale.total_minor)}</strong></div>
                {sale.paid_at && <p className="demo-note">{new Date(sale.paid_at).toLocaleString()}</p>}
                <div>
                  {sale.lines.map((l) => (
                    <div className="transaction-row" key={l.id}>
                      <span>{l.quantity} × {money(l.unit_price_minor)} {l.description}</span>
                      <strong>{money(l.line_total_minor)}</strong>
                    </div>
                  ))}
                </div>
                <div className="demo-actions">
                  <button type="button" className="button button--green" onClick={startNewSale}>Start a new sale</button>
                </div>
              </section>
            )}
          </>
        )}

        {view === "find" && (
          <section className="payment-panel demo-panel">
            <h1 className="demo-heading">Find a sale</h1>
            <div className="demo-row">
              <label className="demo-field demo-field--grow">
                <span>Sale ID</span>
                <input value={findId} onChange={(e) => setFindId(e.target.value)} placeholder="Sale ID" />
              </label>
              <button type="button" className="button button--green" disabled={busy} onClick={() => handleFind()}>Find</button>
            </div>

            {foundSale && (
              <div className="demo-divider">
                <div className="payment-head">
                  <div>
                    <small>{foundSale.id}</small>
                    <strong>{money(foundSale.total_minor)}</strong>
                  </div>
                  <StatusBadge status={foundSale.status} />
                </div>
                <div>
                  {foundSale.lines.map((l) => (
                    <div className="transaction-row" key={l.id}>
                      <span>{l.quantity} × {l.description}</span>
                      <strong>{money(l.line_total_minor)}</strong>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="demo-divider">
              <p className="eyebrow" style={{ margin: 0 }}>This session</p>
              {sessionSales.length === 0 ? (
                <p className="demo-note">No sales yet in this session.</p>
              ) : (
                <ul className="demo-list">
                  {sessionSales.map((s) => (
                    <li key={s.id}>
                      <button type="button" onClick={() => { setFindId(s.id); void handleFind(s.id); }}>
                        <span>{s.id.slice(0, 8)}</span>
                        <span className="demo-note">{new Date(s.created_at).toLocaleDateString()}</span>
                        <b>{money(s.total_minor)}</b>
                        <StatusBadge status={s.status} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        )}

        <p className={`demo-alert${pending ? " demo-alert--pending" : ""}`} aria-live="polite">
          {message}
        </p>
      </main>

      {settingsOpen && (
        <div className="demo-sheet" onClick={() => setSettingsOpen(false)}>
          <aside className="payment-panel demo-panel" role="dialog" aria-label="Settings" onClick={(e) => e.stopPropagation()}>
            <div className="payment-head">
              <div><strong style={{ fontSize: "1.6rem" }}>Settings</strong></div>
              <button type="button" className="button button--outline" onClick={() => setSettingsOpen(false)}>Close</button>
            </div>
            <label className="demo-field">
              <span>X-Tenant-Id</span>
              <input value={settings.tenantId} onChange={(e) => setSettings({ ...settings, tenantId: e.target.value })} />
            </label>
            <label className="demo-field">
              <span>X-User-Id</span>
              <input value={settings.userId} onChange={(e) => setSettings({ ...settings, userId: e.target.value })} />
            </label>
            <label className="demo-field">
              <span>Access header</span>
              <select value={settings.role} onChange={(e) => setSettings({ ...settings, role: e.target.value as IdentitySettings["role"] })}>
                <option value="attendant">Can create sales</option>
                <option value="owner">Read-only checks</option>
              </select>
            </label>
            <label className="demo-switch">
              <input
                type="checkbox"
                checked={previewLocked ? true : settings.simulate}
                disabled={previewLocked}
                onChange={(e) => setSettings({ ...settings, simulate: e.target.checked })}
              />
              <span>Simulate responses{previewLocked && <small>Always on in this preview.</small>}</span>
            </label>
            {simulating && (
              <label className="demo-switch">
                <input
                  type="checkbox"
                  checked={settings.simulatorAutoConfirm}
                  onChange={(e) => setSettings({ ...settings, simulatorAutoConfirm: e.target.checked })}
                />
                <span>Simulator auto-confirms payment<small>Turn off to preview the still-pending state.</small></span>
              </label>
            )}
            <p className="demo-note">Calls use relative URLs and demo identity headers. Payment callbacks are never called from this interface.</p>
          </aside>
        </div>
      )}
    </div>
  );
}

