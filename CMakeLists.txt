cmake_minimum_required(VERSION 3.25)
project(SuperYatzy VERSION 1.1 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 26)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(APPLE)
    enable_language(OBJCXX)
    set(CMAKE_OBJCXX_STANDARD 26)
    set(CMAKE_OBJCXX_STANDARD_REQUIRED ON)
    set(CMAKE_OBJCXX_EXTENSIONS OFF)
    if(NOT CMAKE_OSX_DEPLOYMENT_TARGET)
        set(CMAKE_OSX_DEPLOYMENT_TARGET "15.0")
    endif()
endif()

# This game uses the SFML 2 API. SFML 3 is a different API.
find_package(SFML 2.6 COMPONENTS graphics window system REQUIRED)
add_executable(super_yatzy MACOSX_BUNDLE main.cpp game.hpp)
target_link_libraries(super_yatzy PRIVATE sfml-graphics sfml-window sfml-system)

if(APPLE)
    target_sources(super_yatzy PRIVATE macos_display.mm macos_display.hpp)
    target_link_libraries(super_yatzy PRIVATE "-framework AppKit" "-framework OpenGL")
    set_target_properties(super_yatzy PROPERTIES
        MACOSX_BUNDLE_INFO_PLIST "${CMAKE_CURRENT_SOURCE_DIR}/assets/Info.plist.in"
        MACOSX_BUNDLE_SHORT_VERSION_STRING "${PROJECT_VERSION}"
        MACOSX_BUNDLE_BUNDLE_VERSION "2"
    )
endif()

if(MSVC)
    target_compile_options(super_yatzy PRIVATE /W4)
else()
    target_compile_options(super_yatzy PRIVATE -Wall -Wextra -Wpedantic)
endif()

set_target_properties(super_yatzy PROPERTIES
    MACOSX_BUNDLE_BUNDLE_NAME "Super Yatzy"
    MACOSX_BUNDLE_GUI_IDENTIFIER "local.superyatzy.game"
)

# For a self-contained macOS release app, use build_macos.sh instead.
