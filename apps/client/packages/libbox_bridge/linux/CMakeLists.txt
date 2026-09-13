cmake_minimum_required(VERSION 3.10)
project(libbox_bridge_plugin LANGUAGES CXX)

set(PLUGIN_NAME "strict_proxy_libbox_bridge_plugin")
add_library(${PLUGIN_NAME} SHARED
  "libbox_bridge_plugin.cc"
)
apply_standard_settings(${PLUGIN_NAME})
set_target_properties(${PLUGIN_NAME} PROPERTIES CXX_VISIBILITY_PRESET hidden)
target_compile_definitions(${PLUGIN_NAME} PRIVATE FLUTTER_PLUGIN_IMPL)
target_include_directories(${PLUGIN_NAME} PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/include")
target_link_libraries(${PLUGIN_NAME} PRIVATE flutter PkgConfig::GTK)

set(libbox_bridge_bundled_libraries
  "${PLUGIN_NAME}"
  PARENT_SCOPE
)
