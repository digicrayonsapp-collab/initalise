'use strict';

const EventEmitter = require('events');
const { notifySuccess, notifyFailure, notifySummary } = require('./notify');

const bus = new EventEmitter();
let wired = false;

function initBus() {
    if (wired) return bus;
    wired = true;

    bus.on('sync:success', function (ev) {
        // fire and forget
        notifySuccess(ev).catch(function () { });
    });

    bus.on('sync:failure', function (ev) {
        notifyFailure(ev).catch(function () { });
    });

    bus.on('sync:summary', function (stats) {
        notifySummary(stats).catch(function () { });
    });

    return bus;
}

module.exports = { bus, initBus };
