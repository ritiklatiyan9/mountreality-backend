const PROFILE_JURISDICTION_CONSTRAINTS = new Set([
  'site_profile_ruleset_inactive',
  'site_profile_ruleset_country_mismatch',
  'site_profile_ruleset_jurisdiction_mismatch',
]);

const errorMiddleware = (err, req, res, _next) => {
  const profileJurisdictionConflict = err?.code === '23514'
    && PROFILE_JURISDICTION_CONSTRAINTS.has(String(err?.constraint || ''));
  const reraControlConflict = err?.code === '23514'
    && /^(?:Reject linked RERA (?:finance|deposit) controls|RERA evidence cannot be moved or deleted|Bank details cannot change while this account has active RERA|Close or reject the reviewed RERA mapping)/
      .test(String(err?.message || ''));
  const requestedStatus = Number(err?.statusCode || err?.status);
  const status = profileJurisdictionConflict
    ? 422
    : reraControlConflict
    ? 409
    : (Number.isInteger(requestedStatus) && requestedStatus >= 400 && requestedStatus <= 599
      ? requestedStatus
      : 500);
  const expected = status < 500;
  const responseCode = profileJurisdictionConflict
    ? 'RULESET_JURISDICTION_MISMATCH'
    : reraControlConflict ? 'RERA_CONTROL_CONFLICT' : err?.code;
  console.error(`[${req.method} ${req.originalUrl}] request_id=${req.requestId || 'unknown'}`, err?.stack || err);
  res.status(status).json({
    message: expected ? (err?.message || 'The request could not be completed') : 'An unexpected server error occurred',
    requestId: req.requestId,
    ...(expected && responseCode ? { code: responseCode } : {}),
    ...(expected && err?.details !== undefined ? { details: err.details } : {}),
  });
};

export default errorMiddleware;
