'use strict';

class AppError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status || 500;
    this.details = details;
  }
}

const toAppError = (err) => {
  if (err instanceof AppError) return err;
  const status = err?.status || err?.response?.status || 500;
  const message =
    err?.message ||
    err?.response?.data?.error ||
    'Internal Server Error';
  const details = err?.response?.data || err?.details;
  return new AppError(status, message, details);
};

module.exports = { AppError, toAppError };
