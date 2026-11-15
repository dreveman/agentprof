// SPDX-License-Identifier: Apache-2.0

import SwiftUI
import WebKit

/// Full-screen profiler view with import indicator and error alerts.
struct ProfilerScreen: View {
  @Bindable var controller: ProfilerController

  var body: some View {
    ProfilerWebView(controller: controller, actions: controller.pageActions)
      .ignoresSafeArea(.container)
      .background(Color(uiColor: .systemBackground))
      .overlay(alignment: .bottom) {
        if let name = controller.importing {
          Label {
            Text(verbatim: "Opening \(name)…")
          } icon: {
            Image(systemName: "doc.text.magnifyingglass")
          }
          .font(.callout)
          .lineLimit(1)
          .truncationMode(.middle)
          .padding(.horizontal, 16)
          .padding(.vertical, 10)
          .background(.regularMaterial, in: Capsule())
          .padding(.bottom, 24)
          .transition(.opacity)
        }
      }
      .alert(
        controller.alert?.title ?? "",
        isPresented: Binding(get: { controller.alert != nil }, set: { if !$0 { controller.alert = nil } }),
        presenting: controller.alert
      ) { _ in
        Button(role: .cancel) {
        } label: {
          Text(verbatim: "OK")
        }
      } message: { alert in
        Text(alert.message)
      }
      .onOpenURL { controller.open($0) }
      .task { await controller.removeOldTraces() }
  }
}

struct ProfilerWebView: UIViewControllerRepresentable {
  let controller: ProfilerController
  /// Passed explicitly so SwiftUI calls `updateUIViewController` whenever actions change.
  let actions: [PageAction]

  func makeCoordinator() -> WebViewCoordinator {
    WebViewCoordinator(controller: controller)
  }

  func makeUIViewController(context: Context) -> ProfilerHostViewController {
    let webView = ProfilerWebViewFactory.makeWebView(resources: controller.resources)
    webView.navigationDelegate = context.coordinator
    webView.uiDelegate = context.coordinator
    controller.attach(webView)
    return ProfilerHostViewController(controller: controller, webView: webView)
  }

  func updateUIViewController(_ host: ProfilerHostViewController, context: Context) {
    host.updateBar()
  }
}
