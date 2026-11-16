// SPDX-License-Identifier: Apache-2.0

import Foundation

/// The contract between the native app and the AgentProf UI: `window.agentprofHost`, defined in the
/// page world before the UI's own scripts run.
///
/// - `platform` (`"ios"`), `appVersion`: identifies the native iOS host.
/// - `onOpenTrace`: set by the UI to stream recordings handed to it (`{url, name}`). Until set,
///   `openTrace(url, name)` falls back to Perfetto's `postMessage` API (`PING`/`PONG`, then buffer).
/// - `setActions(actions)` / `onRunAction` / `nativeBar` / `nativeBarWidth`: synchronizes top-bar
///   actions with a native vertical system bar when present, dispatching `agentprofhostchange`.
/// - `recentTraces` / `setRecentTraces(items)` / `onOpenRecentTrace` / `onRemoveRecentTrace`:
///   exposes recordings stored in `TraceInbox` on the UI's Home page.
///
/// Also hides the Cache API (`window.caches`), which rejects custom-scheme URLs and would otherwise
/// store duplicate copies of recordings in WebKit data storage.
enum HostBridge {
  /// The JavaScript run in the page world at document start.
  static func bootstrapScript(appVersion: String, idiom: String = "phone") -> String {
    let config: [String: Any] = [
      "platform": "ios",
      "idiom": idiom,
      "appVersion": appVersion,
    ]
    let json =
      (try? JSONSerialization.data(withJSONObject: config, options: [.sortedKeys]))
      .flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
    return
      bootstrapTemplate
      .replacingOccurrences(of: "__CONFIG__", with: json)
      .replacingOccurrences(of: "__ACTIONS_HANDLER__", with: actionsHandlerName)
      .replacingOccurrences(of: "__RECENTS_HANDLER__", with: recentTracesHandlerName)
  }

  /// Hands a recording to the UI; run with `callAsyncJavaScript` and arguments `url`, `name`.
  static let openTraceCall = "return await window.agentprofHost.openTrace(url, name);"

  /// Runs one of the UI's top-bar actions; run with `callAsyncJavaScript` and argument `id`.
  static let runActionCall = "await window.agentprofHost.runAction(id);"

  /// Tells the UI whether the app renders its buttons natively; run with arguments `on`, `width`.
  static let setNativeBarCall = "window.agentprofHost.setNativeBar(on, width);"

  /// Updates the Home page's recent traces list; run with argument `items`.
  static let setRecentTracesCall = "window.agentprofHost.setRecentTraces(items);"

  /// Script message handler receiving `setActions` updates from the page.
  static let actionsHandlerName = "agentprofActions"

  /// Script message handler receiving `onOpenRecentTrace` / `onRemoveRecentTrace` requests.
  static let recentTracesHandlerName = "agentprofRecentTraces"

  private static let bootstrapTemplate = #"""
    (() => {
      'use strict';
      if (window.agentprofHost !== undefined) return;
      const config = __CONFIG__;
      const READY_TIMEOUT_MS = 60000;

      function whenUIReady() {
        return new Promise((resolve, reject) => {
          const deadline = Date.now() + READY_TIMEOUT_MS;
          let timer;
          const done = () => {
            clearInterval(timer);
            window.removeEventListener('message', onMessage);
          };
          const onMessage = (event) => {
            if (event.source === window && event.data === 'PONG') {
              done();
              resolve();
            }
          };
          const ping = () => {
            if (Date.now() > deadline) {
              done();
              reject(new Error('The AgentProf UI did not start.'));
              return;
            }
            window.postMessage('PING', '*');
          };
          window.addEventListener('message', onMessage);
          timer = setInterval(ping, 100);
          ping();
        });
      }

      const host = {
        platform: config.platform,
        idiom: config.idiom,
        appVersion: config.appVersion,
        onOpenTrace: undefined,
        nativeBar: false,
        nativeBarWidth: 0,
        recentTraces: Object.freeze([]),
        onRunAction: undefined,
        setActions(actions) {
          const handler = window.webkit?.messageHandlers?.__ACTIONS_HANDLER__;
          if (handler) handler.postMessage(actions);
        },
        setNativeBar(on, width) {
          const nativeBar = Boolean(on);
          const nativeBarWidth = nativeBar && Number.isFinite(width) && width > 0 ? Number(width) : 0;
          if (host.nativeBar === nativeBar && host.nativeBarWidth === nativeBarWidth) return;
          host.nativeBar = nativeBar;
          host.nativeBarWidth = nativeBarWidth;
          window.dispatchEvent(new Event('agentprofhostchange'));
        },
        setRecentTraces(items) {
          const normalized = Array.isArray(items)
            ? items.map((item) => Object.freeze({...item}))
            : [];
          host.recentTraces = Object.freeze(normalized);
          window.dispatchEvent(new Event('agentprofhostchange'));
        },
        onOpenRecentTrace(id) {
          const handler = window.webkit?.messageHandlers?.__RECENTS_HANDLER__;
          if (handler) handler.postMessage({action: 'open', id: String(id)});
        },
        onRemoveRecentTrace(id) {
          const target = String(id);
          host.recentTraces = Object.freeze(
            host.recentTraces.filter((item) => item.id !== target),
          );
          const handler = window.webkit?.messageHandlers?.__RECENTS_HANDLER__;
          if (handler) handler.postMessage({action: 'remove', id: target});
        },
        async runAction(id) {
          if (typeof host.onRunAction === 'function') await host.onRunAction(id);
        },
        async openTrace(url, name) {
          if (typeof host.onOpenTrace !== 'function') {
            await whenUIReady();
          }
          if (typeof host.onOpenTrace === 'function') {
            await host.onOpenTrace({url, name});
            return 'handler';
          }
          const response = await fetch(url);
          if (!response.ok) {
            throw new Error(`Could not read ${name} (HTTP ${response.status}).`);
          }
          const buffer = await response.arrayBuffer();
          window.postMessage(
            {perfetto: {buffer, title: name, keepApiOpen: true, downloadable: true, shareable: false}},
            '*',
            [buffer],
          );
          return 'postMessage';
        },
      };
      Object.defineProperty(window, 'agentprofHost', {value: host, enumerable: true});
      Object.defineProperty(window, 'caches', {value: undefined});
    })();
    """#
}
