'use strict';

class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** Wrap async route handlers so rejections reach the error middleware (Express 4). */
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function uuidParam(req, res, next, value) {
  if (!UUID_RE.test(value)) return next(new HttpError(404, 'not_found', 'Resource not found'));
  next();
}

function notFound(req, res, next) {
  next(new HttpError(404, 'not_found', 'Route not found'));
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  let status = err.status || 500;
  let code = err.code || 'internal_error';
  let message = err.message;

  if (err.name === 'TaxError' || err.name === 'RefundError') {
    status = 422;
  } else if (err.type === 'entity.parse.failed') {
    status = 400;
    code = 'invalid_json';
    message = 'Request body is not valid JSON';
  } else if (err.code === '23505') {
    status = 409;
    code = 'conflict';
    message = 'A resource with the same unique value already exists';
  } else if (!(err instanceof HttpError)) {
    status = 500;
    code = 'internal_error';
    message = 'Internal server error';
    console.error(err);
  }

  res.status(status).json({ error: { code, message, details: err.details } });
}

module.exports = { HttpError, h, uuidParam, notFound, errorHandler };
