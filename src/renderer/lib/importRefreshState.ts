export function shouldQueueImportRefresh(
  activeInvoiceId: string | null,
  openingInvoiceId: string | null,
  completedInvoiceId: string
): boolean {
  return activeInvoiceId === completedInvoiceId || openingInvoiceId === completedInvoiceId;
}

export function retainImportRefreshForInvoice(
  pending: ReadonlySet<string>,
  invoiceId: string
): ReadonlySet<string> {
  if (pending.size === 0 || (pending.size === 1 && pending.has(invoiceId))) return pending;
  return pending.has(invoiceId) ? new Set([invoiceId]) : new Set();
}

export function clearImportRefresh(
  pending: ReadonlySet<string>,
  invoiceId: string
): ReadonlySet<string> {
  if (!pending.has(invoiceId)) return pending;
  const next = new Set(pending);
  next.delete(invoiceId);
  return next;
}
