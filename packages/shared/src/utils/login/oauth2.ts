/* eslint-disable no-console */
import { DERIV_OAUTH_CLIENT_ID, DERIV_OAUTH_REDIRECT_URI } from '../config/config';
import { buildLoginQuery, OAUTH_ACCOUNTS_KEY, OAUTH_STORAGE_KEY, readOAuthAccounts } from './oauth-accounts';

/**
 * Deriv's new OAuth 2.0 (Authorization Code + PKCE) sign-in.
 * Docs: https://developers.deriv.com/docs/workflows/
 */

const AUTH_URL = 'https://auth.deriv.com/oauth2/auth';
const TOKEN_URL = 'https://auth.deriv.com/oauth2/token';
const ACCOUNTS_URL = 'https://api.derivws.com/trading/v1/options/accounts';
const SCOPE = 'trade';
const VERIFIER_KEY = 'deriv_oauth_code_verifier';
const STATE_KEY = 'deriv_oauth_state';

const base64Url = (bytes: Uint8Array) =>
    btoa(String.fromCharCode(...Array.from(bytes)))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');

const randomString = (length = 64) => {
    const bytes = new Uint8Array(length);
    window.crypto.getRandomValues(bytes);
    return base64Url(bytes).slice(0, length);
};

const sha256 = async (value: string) =>
    new Uint8Array(await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));

/** Sends the browser to Deriv's sign-in page. */
export const startOAuth2Login = async () => {
    const code_verifier = randomString(64);
    const state = randomString(32);
    const code_challenge = base64Url(await sha256(code_verifier));

    sessionStorage.setItem(VERIFIER_KEY, code_verifier);
    sessionStorage.setItem(STATE_KEY, state);

    const params = new URLSearchParams({
        response_type: 'code',
        client_id: DERIV_OAUTH_CLIENT_ID,
        redirect_uri: DERIV_OAUTH_REDIRECT_URI,
        scope: SCOPE,
        state,
        code_challenge,
        code_challenge_method: 'S256',
    });
    window.location.href = `${AUTH_URL}?${params.toString()}`;
};

const showStatus = (title: string, lines: string[], ok: boolean) => {
    document.title = 'Sign in';
    document.body.innerHTML = '';
    const box = document.createElement('div');
    box.style.cssText = 'font-family:system-ui,Arial,sans-serif;max-width:680px;margin:32px auto;padding:0 16px;color:#222';
    const h = document.createElement('h2');
    h.textContent = title;
    h.style.color = ok ? '#0a7d3b' : '#c4121f';
    const pre = document.createElement('pre');
    pre.style.cssText = 'white-space:pre-wrap;word-break:break-all;background:#f4f6f8;padding:12px;border-radius:6px;font-size:13px';
    pre.textContent = lines.join('\n');
    const a = document.createElement('a');
    a.href = '/';
    a.textContent = 'Back to DBtraders';
    a.style.cssText = 'display:inline-block;margin-top:12px;padding:10px 18px;background:#ff444f;color:#fff;border-radius:6px;text-decoration:none';
    box.append(h, pre, a);
    document.body.appendChild(box);
};

const redact = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>).map(([key, v]) =>
                /token|secret|password|otp/i.test(key) ? [key, '[hidden]'] : [key, redact(v)]
            )
        );
    }
    return value;
};

/**
 * Call at app start. If the page is the OAuth redirect (/callback), finishes the
 * sign-in, shows the result, and returns true so the normal app does not start.
 */
export const handleOAuth2Callback = (): boolean => {
    if (window.location.pathname.replace(/\/+$/, '') !== '/callback') return false;

    const query = new URLSearchParams(window.location.search);
    const error = query.get('error');
    const code = query.get('code');
    const state = query.get('state');
    showStatus('Signing you in...', ['Please wait.'], true);

    (async () => {
        try {
            if (error) throw new Error(`Deriv returned: ${error} ${query.get('error_description') || ''}`);
            if (!code) throw new Error('No authorization code in the address.');
            if (!state || state !== sessionStorage.getItem(STATE_KEY)) {
                throw new Error('State check failed (the sign-in was not started from this browser tab).');
            }
            const code_verifier = sessionStorage.getItem(VERIFIER_KEY) || '';

            const token_response = await fetch(TOKEN_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    grant_type: 'authorization_code',
                    client_id: DERIV_OAUTH_CLIENT_ID,
                    code,
                    redirect_uri: DERIV_OAUTH_REDIRECT_URI,
                    code_verifier,
                }).toString(),
            });
            const token_json = await token_response.json().catch(() => ({}));
            if (!token_response.ok || !token_json.access_token) {
                throw new Error(`Token exchange failed (${token_response.status}): ${JSON.stringify(redact(token_json))}`);
            }

            localStorage.setItem(
                OAUTH_STORAGE_KEY,
                JSON.stringify({
                    access_token: token_json.access_token,
                    expires_at: Date.now() + (Number(token_json.expires_in) || 0) * 1000,
                })
            );
            sessionStorage.removeItem(VERIFIER_KEY);
            sessionStorage.removeItem(STATE_KEY);

            const lines = ['Signed in. Token saved in this browser.', `Token lifetime: ${token_json.expires_in}s`];
            try {
                const accounts_response = await fetch(ACCOUNTS_URL, {
                    headers: { Authorization: `Bearer ${token_json.access_token}`, 'Content-Type': 'application/json' },
                });
                const accounts_json = await accounts_response.json().catch(() => ({}));
                localStorage.setItem(OAUTH_ACCOUNTS_KEY, JSON.stringify(accounts_json));
                lines.push('', `Accounts request: ${accounts_response.status}`, JSON.stringify(redact(accounts_json), null, 2));
            } catch (e) {
                lines.push('', `Accounts request failed: ${(e as Error).message}`);
            }

            // Hand the login to the app: it expects acct1/token1/cur1... in the address, calls
            // `authorize` and builds its own account list from the answer. Old stored accounts
            // are cleared first, otherwise the app treats the new login as a token mismatch.
            const accounts = readOAuthAccounts();
            if (accounts.length) {
                localStorage.removeItem('client.accounts');
                localStorage.removeItem('active_loginid');
                window.location.replace(`/?${buildLoginQuery(accounts)}`);
                return;
            }
            lines.push('', 'No accounts were returned, so the app was not opened.');
            showStatus('Signed in, but no accounts', lines, false);
        } catch (e) {
            console.error(e);
            showStatus('Sign in failed', [(e as Error).message], false);
        }
    })();

    return true;
};
