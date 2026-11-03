/* eslint-disable import/no-named-as-default-member */
/* eslint-disable import/no-named-as-default */
import ReactDOM from 'react-dom';
import React from 'react';
import 'babel-polyfill';
import 'promise-polyfill';
// eslint-disable-next-line
import registerServiceWorker from 'Utils/pwa';
import initStore from 'App/initStore';
import App from 'App/app.jsx';
import { checkAndSetEndpointFromUrl, handleOAuth2Callback, initDebugPanel } from '@deriv/shared';
import AppNotificationMessages from './App/Containers/app-notification-messages.jsx';

if (
    !!window?.localStorage.getItem?.('debug_service_worker') || // To enable local service worker related development
    (!window.location.hostname.startsWith('localhost') && !/binary\.sx/.test(window.location.hostname)) ||
    window.location.hostname === 'deriv-app.binary.sx'
) {
    registerServiceWorker();
}

// if we don't clear the local storage, then exchange_rates subscription calls won't be made when user refreshes the page
// check packages/stores/src/providers/ExchangeRatesProvider.tsx

if (window.localStorage.getItem('exchange_rates')) {
    window.localStorage.removeItem('exchange_rates');
}
initDebugPanel();
const has_endpoint_url = checkAndSetEndpointFromUrl();
const is_oauth_callback = !has_endpoint_url && handleOAuth2Callback();

// if has endpoint url, APP will be redirected. On the OAuth callback page the sign-in is completed instead.
if (!has_endpoint_url && !is_oauth_callback) {
    const root_store = initStore(AppNotificationMessages);

    // Live app state for the on-screen debug panel (?debug=1); does nothing otherwise.
    if (window.localStorage.getItem('deriv_debug_panel') === '1') {
        setInterval(() => {
            try {
                const { client, common } = root_store as any;
                window.dispatchEvent(
                    new CustomEvent('deriv-state-log', {
                        detail: {
                            logged_in: client.is_logged_in,
                            logging_in: client.is_logging_in,
                            populating_accounts: client.is_populating_account_list,
                            loginid: client.loginid,
                            accounts: Object.keys(client.accounts || {}).length,
                            socket_opened: common.is_socket_opened,
                            path: window.location.pathname,
                        },
                    })
                );
            } catch (e) {
                // diagnostics must never break the app
            }
        }, 3000);
    }

    const wrapper = document.getElementById('deriv_app');
    if (wrapper) {
        ReactDOM.render(<App useSuspense={false} root_store={root_store} />, wrapper);
    }
}
