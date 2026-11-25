import React, {useReducer, useState} from 'react';
import {render} from 'react-dom';
import {ConnectionSettings, GitConnectionPreferences} from '../src/connection-settings.tsx';

const origin = 'https://github.com/fixture/project';
let renderPort;
const host = document.createElement('div');
document.body.append(host);

globalThis.mountConnectionSettings = ({dialog, modes = ['desktop', 'cloudflare'],
    methods = ['fine-grained-pat', 'git-credential-helper'], connected = false} = {}) => {
    const calls = [];
    let remainingFailures = 0;
    let methodList = methods;
    let mode = connected ? 'desktop' : null;
    let state = connected ? {status: 'connected', account: {login: 'fixture'}} : {status: 'disconnected'};
    const readOrigin = async () => origin;
    const port = {
        modes,
        getView: () => ({mode, state}),
        async select(next) {
            calls.push(['select', next]);
            mode = next;
        },
        async getDesktopAuthMethods() {return methodList;},
        async connect(...args) {
            calls.push(['connect', ...args]);
            if (remainingFailures) {
                remainingFailures--;
                throw new Error('FIXTURE_CONNECTION_FAILED');
            }
            state = {status: 'connected', account: {login: 'fixture'}};
        },
        async disconnect() {
            calls.push(['disconnect', mode]);
            state = {status: 'disconnected'};
        },
        async refresh() {},
        async getSession() {return null;}
    };
    globalThis.connectionFixture = {
        calls,
        failNext() {remainingFailures++;},
        replaceMethods(next) {
            methodList = next;
            // The real host supplies a new settings object when switching repositories.
            renderPort({...port});
        }
    };
    function Harness() {
        const [open, setOpen] = useState(true);
        const [busy, setBusy] = useState(false);
        const [settings, setSettings] = useState(port);
        const [, redraw] = useReducer(n => n + 1, 0);
        renderPort = setSettings;
        if (!open) return null;
        const onClose = () => setOpen(false);
        return dialog === 'preferences' ?
            React.createElement(GitConnectionPreferences, {view: window, modes, locale: 'en', onClose}) :
            React.createElement(ConnectionSettings, {view: window, settings, locale: 'en', readOrigin,
                busy, setBusy, onChange: redraw, onClose});
    }
    render(React.createElement(Harness), host);
};
