export function toPercent(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return num > 1 ? num : num * 100;
}

export function toDecimal(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return num > 1 ? num / 100 : num;
}

export function normalizeReconciliationSettingsPayload(payload = {}) {
  const next = { ...payload };

  if (Object.prototype.hasOwnProperty.call(next, "ocrConfidenceThreshold")) {
    next.ocrConfidenceThreshold = toDecimal(next.ocrConfidenceThreshold);
  }

  if (Object.prototype.hasOwnProperty.call(next, "dateDriftToleranceDays")) {
    next.dateDriftToleranceDays = Number(next.dateDriftToleranceDays);
  }

  return next;
}
