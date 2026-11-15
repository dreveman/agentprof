// SPDX-License-Identifier: Apache-2.0

import Foundation

/// One of the UI's top-bar buttons, as reported via `agentprofHost.setActions`, so the app can
/// render them natively when a system vertical bar is active.
struct PageAction: Equatable, Sendable {
  enum Group: String, Sendable {
    /// Primary bar buttons.
    case main
    /// Overflow menu actions.
    case more
  }

  /// Identifier passed back to `agentprofHost.runAction`.
  let id: String
  let label: String
  /// Material Symbols ligature name matching the web UI.
  let icon: String
  let checked: Bool
  let disabled: Bool
  let group: Group

  /// Upper bound on actions accepted from the page.
  static let maxCount = 24

  /// Parses and validates a message body from `PageActionsHandler`.
  static func parse(_ body: Any) -> [PageAction]? {
    guard let list = body as? [Any], list.count <= maxCount else { return nil }
    var actions: [PageAction] = []
    for entry in list {
      guard let fields = entry as? [String: Any],
        let id = fields["id"] as? String, isToken(id, allowing: "-"),
        let label = fields["label"] as? String, !label.isEmpty, label.count <= 64,
        let icon = fields["icon"] as? String, isToken(icon, allowing: "_"),
        let checked = fields["checked"] as? Bool,
        let disabled = fields["disabled"] as? Bool,
        let group = (fields["group"] as? String).flatMap(Group.init(rawValue:)),
        !actions.contains(where: { $0.id == id })
      else { return nil }
      actions.append(PageAction(id: id, label: label, icon: icon, checked: checked, disabled: disabled, group: group))
    }
    return actions
  }

  /// Lowercase ASCII letters and digits, plus `separator`; 1 to 40 characters.
  private static func isToken(_ value: String, allowing separator: Character) -> Bool {
    (1...40).contains(value.count)
      && value.allSatisfy { ("a"..."z").contains($0) || ("0"..."9").contains($0) || $0 == separator }
  }

  /// Fallback SF Symbol when the bundled Material Symbols font is unavailable.
  var systemImage: String {
    Self.systemImages[icon] ?? "circle"
  }

  private static let systemImages: [String: String] = [
    "home": "house",
    "search": "magnifyingglass",
    "dashboard": "rectangle.3.group",
    "line_style": "timeline.selection",
    "terminal": "terminal",
    "folder_open": "folder",
    "download": "arrow.down.circle",
    "info": "info.circle",
    "dark_mode": "moon",
    "settings": "gearshape",
    "close": "xmark",
  ]
}
