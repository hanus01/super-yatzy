#include "macos_display.hpp"

#import <AppKit/AppKit.h>

#include <algorithm>
#include <cmath>

// NSOpenGLView remains the drawable used by SFML 2.  Its modern macOS
// deprecation does not affect the Retina backing-store APIs used below.
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"

namespace {

NSWindow* nativeWindow(void* handle) {
    id object = static_cast<id>(handle);
    if ([object isKindOfClass:[NSWindow class]]) return object;
    if ([object isKindOfClass:[NSView class]]) return [object window];
    return nil;
}

NSOpenGLView* openGLView(NSView* view) {
    if ([view isKindOfClass:[NSOpenGLView class]])
        return static_cast<NSOpenGLView*>(view);

    for (NSView* child in [view subviews])
        if (NSOpenGLView* found = openGLView(child)) return found;

    return nil;
}

NSOpenGLView* drawableView(void* handle) {
    id object = static_cast<id>(handle);
    if ([object isKindOfClass:[NSView class]])
        return openGLView(static_cast<NSView*>(object));
    return openGLView([nativeWindow(handle) contentView]);
}

macos_display::Size roundedSize(NSSize size) {
    return {
        static_cast<unsigned>(std::max(0.0, std::round(size.width))),
        static_cast<unsigned>(std::max(0.0, std::round(size.height)))
    };
}

} // namespace

namespace macos_display {

bool enableRetina(void* windowHandle) {
    @autoreleasepool {
        NSOpenGLView* view = drawableView(windowHandle);
        if (!view) return false;

        // SFML 2.6 creates its view with a low-resolution surface.  Enable the
        // native Retina surface without changing SFML's event coordinates:
        // they deliberately remain logical points, including mouse events.
        [view setWantsBestResolutionOpenGLSurface:YES];
        [[view openGLContext] update];
        [view update];
        return [view wantsBestResolutionOpenGLSurface] == YES;
    }
}

Size logicalSize(void* windowHandle) {
    @autoreleasepool {
        NSOpenGLView* view = drawableView(windowHandle);
        return view ? roundedSize([view bounds].size) : Size{};
    }
}

Size drawableSize(void* windowHandle) {
    @autoreleasepool {
        NSOpenGLView* view = drawableView(windowHandle);
        if (!view) return {};

        // Ask the view instead of assuming every display is Retina.  This
        // follows the display backing scale after moving the window between
        // monitors as well as after ordinary window resizing.
        const NSRect bounds = [view bounds];
        return roundedSize([view wantsBestResolutionOpenGLSurface]
            ? [view convertRectToBacking:bounds].size : bounds.size);
    }
}

double scaleFactor(void* windowHandle) {
    const auto logical = logicalSize(windowHandle);
    const auto pixels = drawableSize(windowHandle);
    return logical.width ? static_cast<double>(pixels.width) / logical.width
                         : 1.0;
}

void fitWindowToScreen(void* windowHandle, double preferredWidth,
                       double preferredHeight) {
    @autoreleasepool {
        NSWindow* window = nativeWindow(windowHandle);
        if (!window || preferredWidth <= 0 || preferredHeight <= 0) return;

        NSScreen* screen = [window screen];
        if (!screen) screen = [NSScreen mainScreen];
        if (!screen) return;

        const NSRect visible = [screen visibleFrame];
        const CGFloat margin = 16;
        const NSRect room = NSInsetRect(visible, margin, margin);
        const NSRect contentRoom = [window contentRectForFrameRect:room];
        const double fraction = std::min({
            1.0,
            contentRoom.size.width / preferredWidth,
            contentRoom.size.height / preferredHeight
        });

        const NSRect content = NSMakeRect(0, 0,
            std::max(1.0, std::floor(preferredWidth * fraction)),
            std::max(1.0, std::floor(preferredHeight * fraction)));

        NSRect frame = [window frameRectForContentRect:content];
        frame.origin.x = std::round(NSMidX(visible) - frame.size.width / 2);
        frame.origin.y = std::round(NSMidY(visible) - frame.size.height / 2);
        [window setFrame:frame display:YES];
        [drawableView(windowHandle) update];
    }
}

} // namespace macos_display

#pragma clang diagnostic pop
