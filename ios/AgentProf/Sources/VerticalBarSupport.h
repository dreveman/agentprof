// SPDX-License-Identifier: Apache-2.0

#import <UIKit/UIKit.h>

NS_ASSUME_NONNULL_BEGIN

/// Whether `traitCollection` places navigation items in a system vertical bar.
FOUNDATION_EXPORT BOOL APHasVerticalBar(UITraitCollection *traitCollection) NS_SWIFT_UI_ACTOR;

/// Prefers vertical placement for `barButtonItem` when supported by the SDK and OS.
FOUNDATION_EXPORT void APPreferVerticalBarItem(UIBarButtonItem *barButtonItem) NS_SWIFT_UI_ACTOR;

NS_ASSUME_NONNULL_END
