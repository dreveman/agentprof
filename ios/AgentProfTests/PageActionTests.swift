// SPDX-License-Identifier: Apache-2.0

@testable import AgentProf
import Testing
import UIKit

struct PageActionTests {
  private static func entry(
    id: Any = "timeline",
    label: Any = "Timeline",
    icon: Any = "line_style",
    checked: Any = true,
    disabled: Any = false,
    group: Any = "main"
  ) -> [String: Any] {
    ["id": id, "label": label, "icon": icon, "checked": checked, "disabled": disabled, "group": group]
  }

  @Test
  func readsTheButtonsThePageReports() throws {
    let actions = try #require(
      PageAction.parse([Self.entry(), Self.entry(id: "settings", label: "Settings", icon: "settings", checked: false, disabled: true, group: "more")])
    )
    #expect(
      actions == [
        PageAction(id: "timeline", label: "Timeline", icon: "line_style", checked: true, disabled: false, group: .main),
        PageAction(id: "settings", label: "Settings", icon: "settings", checked: false, disabled: true, group: .more),
      ]
    )
    #expect(PageAction.parse([Any]()) == [])
  }

  enum Value: Sendable {
    case string(String)
    case number(Int)

    var json: Any {
      switch self {
      case .string(let value): value
      case .number(let value): value
      }
    }
  }

  @Test(arguments: [
    ("id", Value.string("Timeline")),
    ("id", .string("time line")),
    ("id", .string("")),
    ("id", .string(String(repeating: "a", count: 41))),
    ("id", .number(7)),
    ("label", .string("")),
    ("label", .string(String(repeating: "a", count: 65))),
    ("icon", .string("line-style")),
    ("icon", .string("<img>")),
    ("checked", .string("yes")),
    ("disabled", .number(1)),
    ("group", .string("side")),
  ])
  func rejectsAListWithAnInvalidButton(field: String, value: Value) {
    var invalid = Self.entry()
    invalid[field] = value.json
    #expect(PageAction.parse([Self.entry(id: "home", icon: "home"), invalid]) == nil)
  }

  @Test
  func rejectsWhatIsntAShortListOfDistinctButtons() {
    #expect(PageAction.parse("timeline") == nil)
    #expect(PageAction.parse([["id": "timeline"]]) == nil)
    #expect(PageAction.parse(Self.entry()) == nil)
    #expect(PageAction.parse([Self.entry(), Self.entry()]) == nil)
    let tooMany = (0...PageAction.maxCount).map { Self.entry(id: "a\($0)") }
    #expect(PageAction.parse(tooMany) == nil)
  }

  @Test(arguments: ["home", "search", "dashboard", "line_style", "terminal", "folder_open", "download", "info", "dark_mode", "settings", "close", "unknown"])
  func everyButtonGetsAnSFSymbol(_ icon: String) {
    let action = PageAction(id: "a", label: "A", icon: icon, checked: false, disabled: false, group: .main)
    #expect(UIImage(systemName: action.systemImage) != nil)
    #expect((action.systemImage == "circle") == (icon == "unknown"))
  }

  @Test @MainActor
  func homeIsTheAgentProfMark() throws {
    let home = PageAction(id: "home", label: "Home", icon: "home", checked: false, disabled: false, group: .main)
    let mark = try #require(ProfilerHostViewController.image(for: home, symbols: nil))
    #expect(mark.size == CGSize(width: 22, height: 22))
    #expect(mark.renderingMode == .alwaysOriginal)
  }
}
