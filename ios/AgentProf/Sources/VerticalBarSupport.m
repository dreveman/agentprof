// SPDX-License-Identifier: Apache-2.0

#import "VerticalBarSupport.h"
#import <Availability.h>

BOOL APHasVerticalBar(UITraitCollection *traitCollection) {
#if defined(__IPHONE_27_1) && __IPHONE_OS_VERSION_MAX_ALLOWED >= __IPHONE_27_1
  if (@available(iOS 27.1, *)) {
    if ([traitCollection respondsToSelector:@selector(verticalBarEdge)]) {
      return traitCollection.verticalBarEdge != UIVerticalBarEdgeUnspecified;
    }
  }
#endif
  (void)traitCollection;
  return NO;
}

void APPreferVerticalBarItem(UIBarButtonItem *barButtonItem) {
#if defined(__IPHONE_27_0) && __IPHONE_OS_VERSION_MAX_ALLOWED >= __IPHONE_27_0
  if (@available(iOS 27.0, *)) {
    if ([barButtonItem respondsToSelector:@selector(setVisibilityPriority:)]) {
      barButtonItem.visibilityPriority = UIBarButtonItemVisibilityPriorityHigh;
    }
  }
#endif
#if defined(__IPHONE_27_1) && __IPHONE_OS_VERSION_MAX_ALLOWED >= __IPHONE_27_1
  if (@available(iOS 27.1, *)) {
    if ([barButtonItem respondsToSelector:@selector(setAxisBehavior:)]) {
      barButtonItem.axisBehavior = UIBarButtonItemAxisBehaviorVerticalPreferred;
    }
  }
#endif
  (void)barButtonItem;
}
