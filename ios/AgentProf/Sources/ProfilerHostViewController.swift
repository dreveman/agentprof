// SPDX-License-Identifier: Apache-2.0

import UIKit
import WebKit

/// Hosts the `WKWebView` and, when UIKit provides a system vertical navigation bar in landscape,
/// renders the UI's top-bar buttons natively in that side bar while hiding the web top bar.
final class ProfilerHostViewController: UIViewController {
  private let controller: ProfilerController
  private let webView: WKWebView
  private let barContent = UIViewController()
  private lazy var barNavigation = UINavigationController(rootViewController: barContent)
  private var shownActions: [PageAction]?
  private lazy var symbols = MaterialSymbols(webUI: controller.resources.webUI)

  /// Overrides `APHasVerticalBar(traitCollection)` in tests.
  var hasVerticalBarOverride: Bool? {
    didSet { view.setNeedsLayout() }
  }

  init(controller: ProfilerController, webView: WKWebView) {
    self.controller = controller
    self.webView = webView
    super.init(nibName: nil, bundle: nil)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .systemBackground

    let navAppearance = UINavigationBarAppearance()
    navAppearance.configureWithTransparentBackground()
    barNavigation.navigationBar.standardAppearance = navAppearance
    barNavigation.navigationBar.scrollEdgeAppearance = navAppearance
    barNavigation.navigationBar.compactAppearance = navAppearance

    let toolbarAppearance = UIToolbarAppearance()
    toolbarAppearance.configureWithTransparentBackground()
    barNavigation.toolbar.standardAppearance = toolbarAppearance
    barNavigation.toolbar.scrollEdgeAppearance = toolbarAppearance
    barNavigation.toolbar.compactAppearance = toolbarAppearance

    barNavigation.view.backgroundColor = .clear
    barContent.view.backgroundColor = .clear
    barNavigation.setNavigationBarHidden(true, animated: false)
    barNavigation.setToolbarHidden(true, animated: false)
    addChild(barNavigation)
    barNavigation.view.frame = view.bounds
    barNavigation.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    view.addSubview(barNavigation.view)
    barNavigation.didMove(toParent: self)

    webView.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(webView)
    let safeArea = view.safeAreaLayoutGuide
    NSLayoutConstraint.activate([
      webView.topAnchor.constraint(equalTo: safeArea.topAnchor),
      webView.leadingAnchor.constraint(equalTo: safeArea.leadingAnchor),
      webView.trailingAnchor.constraint(equalTo: safeArea.trailingAnchor),
      webView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
    ])
  }

  override func viewWillLayoutSubviews() {
    super.viewWillLayoutSubviews()
    updateBar()
  }

  /// Whether the native bar currently displays the UI's buttons.
  var showsButtons: Bool {
    !barNavigation.isNavigationBarHidden || !barNavigation.isToolbarHidden
  }

  /// Items placed at the top of the vertical bar (Home + More menu).
  var topItems: [UIBarButtonItem] {
    barContent.navigationItem.leftBarButtonItems ?? []
  }

  /// Items placed in the bottom-aligned toolbar bubble of the vertical bar, ordered top-to-bottom.
  var bottomItems: [UIBarButtonItem] {
    Array((barContent.toolbarItems ?? []).dropFirst())
  }

  /// Whether the bottom toolbar bubble is visible and preceded by a flexible spacer.
  var isBottomAligned: Bool {
    !barNavigation.isToolbarHidden && (barContent.toolbarItems?.count ?? 0) > bottomItems.count
  }

  func updateBar() {
    let actions = hasVerticalBar ? controller.pageActions : []
    if actions != shownActions {
      shownActions = actions
      let home = actions.filter { $0.id == Self.homeID }
      let menu = actions.filter { $0.group == .more }
      let rest = actions.filter { $0.group == .main && $0.id != Self.homeID }
      barContent.navigationItem.leftBarButtonItems = home.map(item(for:)) + (menu.isEmpty ? [] : [menuItem(for: menu)])
      barContent.navigationItem.rightBarButtonItems = nil
      barContent.setToolbarItems(
        rest.isEmpty ? nil : [.flexibleSpace()] + rest.map(item(for:)),
        animated: false
      )
    }
    let showsTop = !(barContent.navigationItem.leftBarButtonItems ?? []).isEmpty
    if barNavigation.isNavigationBarHidden == showsTop {
      barNavigation.setNavigationBarHidden(!showsTop, animated: false)
    }
    let showsBottom = !(barContent.toolbarItems ?? []).isEmpty
    if barNavigation.isToolbarHidden == showsBottom {
      barNavigation.setToolbarHidden(!showsBottom, animated: false)
    }
    let shows = showsTop || showsBottom
    controller.setNativeBar(shows, width: shows ? barWidth : 0)
  }

  /// Width of the side column inset occupied by the system vertical bar.
  var barWidth: Double {
    Double(max(view.safeAreaInsets.left, view.safeAreaInsets.right))
  }

  private var hasVerticalBar: Bool {
    if let hasVerticalBarOverride { return hasVerticalBarOverride }
    let spansWindow = view.window.map { view.bounds.width >= $0.bounds.width } == true
    return spansWindow && APHasVerticalBar(traitCollection)
  }

  private static let homeID = "home"

  private func item(for action: PageAction) -> UIBarButtonItem {
    let id = action.id
    let item = UIBarButtonItem(
      image: Self.image(for: action, symbols: symbols),
      primaryAction: UIAction { [weak controller] _ in controller?.runPageAction(id) }
    )
    item.accessibilityLabel = action.label
    item.accessibilityIdentifier = id
    item.accessibilityTraits = action.checked ? [.button, .selected] : .button
    item.isEnabled = !action.disabled
    APPreferVerticalBarItem(item)
    return item
  }

  private func menuItem(for actions: [PageAction]) -> UIBarButtonItem {
    let menu = UIMenu(
      children: actions.map { action in
        let id = action.id
        return UIAction(
          title: action.label,
          image: Self.image(for: action, symbols: symbols),
          attributes: action.disabled ? .disabled : [],
          state: action.checked ? .on : .off
        ) { [weak controller] _ in controller?.runPageAction(id) }
      }
    )
    let item = UIBarButtonItem(
      image: symbols?.image(Self.moreIcon, filled: false) ?? UIImage(systemName: "ellipsis"),
      menu: menu
    )
    item.accessibilityLabel = Self.moreLabel
    item.accessibilityIdentifier = Self.moreIcon
    APPreferVerticalBarItem(item)
    return item
  }

  static let moreIcon = "more_horiz"
  static let moreLabel = "More options"

  /// Uses the AgentProf vector mark for Home, Material Symbols glyphs for other actions when the
  /// UI's font is bundled, and SF Symbols otherwise.
  static func image(for action: PageAction, symbols: MaterialSymbols?) -> UIImage? {
    if action.id == homeID, let mark = UIImage(named: "AgentProfMark") {
      return mark.withRenderingMode(.alwaysOriginal)
    }
    return symbols?.image(action.icon, filled: action.checked) ?? UIImage(systemName: action.systemImage)
  }
}
