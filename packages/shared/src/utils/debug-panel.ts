/* eslint-disable no-console */
/**
 * Optional on-screen error panel for people without access to the browser console.
 * Turn on:  open the site with ?debug=1   Turn off: ?debug=0
 */
const FLAG = 'deriv_debug_panel';

export const initDebugPanel = () => {
    try {
        const param = new URLSearchParams(window.location.search).get('debug');
        if (param === '1') localStorage.setItem(FLAG, '1');
        if (param === '0') localStorage.removeItem(FLAG);
        if (localStorage.getItem(FLAG) !== '1') return;
    } catch (e) {
        return;
    }

    const lines: string[] = [];
    const panel = document.createElement('div');
    panel.style.cssText =
        'position:fixed;left:0;bottom:0;z-index:2147483647;width:min(560px,100vw);max-height:45vh;overflow:auto;background:rgba(0,0,0,.88);color:#9ef;font:11px/1.35 ui-monospace,Consolas,monospace;padding:6px 8px;white-space:pre-wrap;word-break:break-all';
    const body = document.createElement('div');
    const bar = document.createElement('div');
    bar.style.cssText = 'position:sticky;top:0;background:#000;padding-bottom:4px';
    const copy = document.createElement('button');
    copy.textContent = 'Copy';
    copy.style.cssText = 'margin-right:8px';
    copy.onclick = () => navigator.clipboard && navigator.clipboard.writeText(lines.join('\n'));
    const close = document.createElement('button');
    close.textContent = 'Hide';
    close.onclick = () => panel.remove();
    bar.append(copy, close, document.createTextNode(' debug panel (?debug=0 turns it off)'));
    panel.append(bar, body);

    const add = (text: string, bad = false) => {
        const time = new Date().toISOString().slice(11, 19);
        const line = `${time} ${text}`;
        lines.push(line);
        if (lines.length > 80) lines.shift();
        body.innerHTML = '';
        lines.forEach(l => {
            const row = document.createElement('div');
            row.textContent = l;
            if (/ERROR|FAIL|error/.test(l)) row.style.color = '#ff8f8f';
            body.appendChild(row);
        });
        panel.scrollTop = panel.scrollHeight;
        return bad;
    };

    const mount = () => document.body && document.body.appendChild(panel);
    if (document.body) mount();
    else window.addEventListener('DOMContentLoaded', mount);

    window.addEventListener('error', e => add(`ERROR ${e.message} @ ${(e.filename || '').split('/').pop()}:${e.lineno}`, true));
    window.addEventListener('unhandledrejection', e => {
        const reason: any = e.reason;
        add(`ERROR promise: ${(reason && (reason.message || JSON.stringify(reason))) || String(reason)}`.slice(0, 400), true);
    });
    const original_error = console.error;
    console.error = (...args: unknown[]) => {
        add(`ERROR console: ${args.map(a => (a instanceof Error ? `${a.message}\n${(a.stack || '').split('\n').slice(0, 3).join('\n')}` : String(a))).join(' ')}`.slice(0, 500), true);
        original_error.apply(console, args as []);
    };
    window.addEventListener('deriv-socket-log', (e: Event) => {
        const d = (e as CustomEvent).detail || {};
        if (d.dir === 'out') add(`-> ${d.type}`);
        else if (d.error) add(`<- ${d.type} ERROR ${d.error.code || ''}: ${d.error.message || ''}`.slice(0, 300));
        else add(`<- ${d.type} ok`);
    });
    add('debug panel on');
};
