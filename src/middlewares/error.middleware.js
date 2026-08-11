const errorMiddleware = (err, req, res, _next) => {
  const requestedStatus = Number(err?.statusCode || err?.status);
  const status = Number.isInteger(requestedStatus) && requestedStatus >= 400 && requestedStatus <= 599
    ? requestedStatus
    : 500;
  const expected = status < 500;
  console.error(`[${req.method} ${req.originalUrl}] request_id=${req.requestId || 'unknown'}`, err?.stack || err);
  res.status(status).json({
    message: expected ? (err?.message || 'The request could not be completed') : 'An unexpected server error occurred',
    requestId: req.requestId,
    ...(expected && err?.code ? { code: err.code } : {}),
    ...(expected && err?.details !== undefined ? { details: err.details } : {}),
  });
};

export default errorMiddleware;
