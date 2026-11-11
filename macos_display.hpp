#pragma once

// The game keeps its interface coordinates in points.  On a Retina screen,
// the OpenGL drawable contains more pixels than the window has points.
// Keep that distinction here rather than changing SFML's internal Cocoa code.
namespace macos_display {

struct Size {
    unsigned width = 0;
    unsigned height = 0;
};

#ifdef __APPLE__
// Pass sf::Window::getSystemHandle().  Call from the window's main thread.
bool enableRetina(void* windowHandle);
Size logicalSize(void* windowHandle);
Size drawableSize(void* windowHandle);
double scaleFactor(void* windowHandle);

// Fit and center the initial content inside this screen's usable area, keeping
// the menu bar, Dock, title bar, and a small outer margin clear of the window.
void fitWindowToScreen(void* windowHandle, double preferredWidth,
                       double preferredHeight);
#else
inline bool enableRetina(void*) { return false; }
inline Size logicalSize(void*) { return {}; }
inline Size drawableSize(void*) { return {}; }
inline double scaleFactor(void*) { return 1.0; }
inline void fitWindowToScreen(void*, double, double) {}
#endif

} // namespace macos_display
