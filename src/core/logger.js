const morgan = require('morgan');

const httpLogger = morgan(':method :url :status :res[content-length] - :response-time ms');

const log = {
  info: (...a) => console.log('ℹ️', ...a),
  warn: (...a) => console.warn('⚠️', ...a),
  error: (...a) => console.error('❌', ...a),
  debug: (...a) => (process.env.NODE_ENV !== 'production') && console.log('🐞', ...a),
};

module.exports = { httpLogger, log };
