'use strict';

require('dotenv').config();

const get = (k, d = undefined) => (process.env[k] !== undefined ? process.env[k] : d);

const getInt = (k, d = 0) => {
  const v = parseInt(process.env[k], 10);
  return Number.isFinite(v) ? v : d;
};

module.exports = { get, getInt };
