// SPDX-License-Identifier: Apache-2.0

import CoreText
import UIKit

/// Renders glyphs from the Material Symbols font shipped inside `AgentProfWeb` (`font-variation-settings`:
/// weight 400, grade 0, optical size 24), outlined or filled for active items.
struct MaterialSymbols {
  /// Relative path to the variable font inside `AgentProfWeb/v<version>/`.
  static let fontPath = "assets/MaterialSymbolsOutlined.woff2"
  /// Rendered icon size in points (matching the font's optical size).
  static let pointSize: CGFloat = 24

  private let font: CTFontDescriptor

  /// Loads the Material Symbols font from `webUI`, or returns nil when unavailable.
  init?(webUI: URL?) {
    guard
      let webUI,
      let entries = try? FileManager.default.contentsOfDirectory(at: webUI, includingPropertiesForKeys: nil)
    else { return nil }
    let fonts = entries.lazy
      .filter { $0.lastPathComponent.hasPrefix("v") }
      .compactMap { try? Data(contentsOf: $0.appendingPathComponent(Self.fontPath)) }
      .compactMap { (CTFontManagerCreateFontDescriptorsFromData($0 as CFData) as? [CTFontDescriptor])?.first }
    guard let font = fonts.first else { return nil }
    self.font = font
  }

  /// Renders the ligature `name` as a template image, or nil if the font has no single glyph for it.
  func image(_ name: String, filled: Bool) -> UIImage? {
    let variations: [NSNumber: NSNumber] = [
      Self.axis("FILL"): filled ? 1 : 0,
      Self.axis("wght"): 400,
      Self.axis("GRAD"): 0,
      Self.axis("opsz"): 24,
    ]
    let descriptor = CTFontDescriptorCreateCopyWithAttributes(
      font,
      [kCTFontVariationAttribute: variations] as CFDictionary
    )
    let ctFont = CTFontCreateWithFontDescriptor(descriptor, Self.pointSize, nil)
    let text = NSAttributedString(
      string: name,
      attributes: [NSAttributedString.Key(kCTFontAttributeName as String): ctFont]
    )
    let line = CTLineCreateWithAttributedString(text)
    guard CTLineGetGlyphCount(line) == 1 else { return nil }

    var ascent: CGFloat = 0
    var descent: CGFloat = 0
    let width = CGFloat(CTLineGetTypographicBounds(line, &ascent, &descent, nil))
    let size = CGSize(width: Self.pointSize, height: Self.pointSize)
    let image = UIGraphicsImageRenderer(size: size).image { context in
      let cgContext = context.cgContext
      cgContext.translateBy(x: 0, y: size.height)
      cgContext.scaleBy(x: 1, y: -1)
      cgContext.textPosition = CGPoint(
        x: (size.width - width) / 2,
        y: (size.height - (ascent + descent)) / 2 + descent
      )
      CTLineDraw(line, cgContext)
    }
    return image.withRenderingMode(.alwaysTemplate)
  }

  private static func axis(_ tag: String) -> NSNumber {
    NSNumber(value: tag.utf8.reduce(UInt32(0)) { $0 << 8 | UInt32($1) })
  }
}
